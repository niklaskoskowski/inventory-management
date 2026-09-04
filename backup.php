<?php
declare(strict_types=1);

/**
 * Inventory Management backup.
 *
 * Two entry points, one implementation:
 *   php backup.php [--force]  the daily cron runner (CLI only); --force writes a
 *                             second, time-stamped backup when today's exists
 *   trax_run_backup(...)      called by restore.php's "Create backup now"
 *
 * Including this file runs nothing and prints nothing: only the runner at the
 * bottom is guarded by the SAPI check, and it fires only when this file *is*
 * the script being executed. The helpers carry a bk_ prefix because restore.php
 * defines its own ensureDir()/copyFileSafe()/copyDirectorySafe()/removeTree()
 * and includes this file.
 */

function bk_ensureDir(string $path, int $mode = 0750): void {
    if (is_dir($path)) return;
    if (!@mkdir($path, $mode, true) && !is_dir($path)) {
        $parent = dirname($path);
        $last = error_get_last();
        throw new RuntimeException(
            "Could not create directory: {$path}\n" .
            "Parent: {$parent}\n" .
            'Parent exists: ' . (is_dir($parent) ? 'yes' : 'no') . "\n" .
            'Parent writable: ' . (is_writable($parent) ? 'yes' : 'no') . "\n" .
            ($last && isset($last['message']) ? 'PHP error: ' . $last['message'] : '')
        );
    }
}

function bk_copyFileSafe(string $source, string $destination): int {
    if (!is_file($source)) return 0;
    bk_ensureDir(dirname($destination));
    if (!@copy($source, $destination)) {
        $last = error_get_last();
        throw new RuntimeException('Could not copy file: ' . $source . ($last && isset($last['message']) ? "\n" . $last['message'] : ''));
    }
    @chmod($destination, 0640);
    return 1;
}

function bk_copyDirectorySafe(string $source, string $destination): array {
    $stats = ['files' => 0, 'dirs' => 0, 'skipped_symlinks' => 0];
    if (!is_dir($source)) return $stats;
    bk_ensureDir($destination);
    $stats['dirs']++;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );
    foreach ($it as $item) {
        $sourcePath = $item->getPathname();
        $relative = substr($sourcePath, strlen(rtrim($source, DIRECTORY_SEPARATOR)) + 1);
        $destinationPath = $destination . DIRECTORY_SEPARATOR . $relative;
        if ($item->isLink()) { $stats['skipped_symlinks']++; continue; }
        if ($item->isDir()) { bk_ensureDir($destinationPath); $stats['dirs']++; continue; }
        if ($item->isFile()) {
            bk_ensureDir(dirname($destinationPath));
            if (!@copy($sourcePath, $destinationPath)) throw new RuntimeException('Could not copy file: ' . $sourcePath);
            @chmod($destinationPath, 0640);
            $stats['files']++;
        }
    }
    return $stats;
}

function bk_removeTree(string $path): void {
    if (!file_exists($path)) return;
    if (is_file($path) || is_link($path)) { @unlink($path); return; }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($it as $item) {
        if ($item->isDir() && !$item->isLink()) @rmdir($item->getPathname()); else @unlink($item->getPathname());
    }
    @rmdir($path);
}

function bk_dirSize(string $path): int {
    if (!is_dir($path)) return 0;
    $size = 0;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($it as $item) {
        if ($item->isFile() && !$item->isLink()) $size += (int)$item->getSize();
    }
    return $size;
}

/**
 * Copy one day's persistent state into $backupRoot/YYYY-MM-DD/.
 *
 * The backup is private: everything lands as 0640 in 0750 directories, because
 * nothing in there is ever served by the web server.
 *
 * A finished backup for today is left alone and reported back with
 * existing => true — unless $force, in which case a second backup is written
 * next to it under a time-stamped name (YYYY-MM-DD_HH-MM-SS, the pre-restore
 * snapshot pattern without its random suffix). The daily folder is never
 * overwritten or deleted. Throws with code 2 when another backup holds the lock.
 *
 * @param callable|null $log fn(string $message): void — progress sink.
 * @param bool $force write a second, time-stamped backup when today's exists.
 * @return array{dir:string,name:string,files:int,dirs:int,symlinks:int,bytes:int,existing:bool}
 */
function trax_run_backup(string $root, string $backupRoot, ?callable $log = null, bool $force = false): array {
    $say = static function (string $message) use ($log): void {
        if ($log !== null) $log($message);
    };

    $today = date('Y-m-d');
    $backupName = $today;
    $finalDir = $backupRoot . '/' . $backupName;
    $lockPath = $backupRoot . '/.backup.lock';

    $say('Application root: ' . $root);
    $say('Backup root: ' . $backupRoot);
    $parent = dirname($backupRoot);
    $say('Backup parent exists: ' . (is_dir($parent) ? 'yes' : 'no'));
    $say('Backup parent writable: ' . (is_writable($parent) ? 'yes' : 'no'));

    if (!is_dir($parent)) throw new RuntimeException('Backup parent does not exist: ' . $parent);
    if (!is_writable($parent) && !is_dir($backupRoot)) throw new RuntimeException('Backup parent is not writable: ' . $parent);

    bk_ensureDir($backupRoot, 0750);

    $lock = @fopen($lockPath, 'c+');
    if (!$lock) throw new RuntimeException('Could not open lock file: ' . $lockPath);
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        throw new RuntimeException('Another backup is already running.', 2);
    }

    try {
        if (is_dir($finalDir) && is_file($finalDir . '/backup-complete.json')) {
            if (!$force) {
                $say('Backup for ' . $today . ' already exists. Nothing to do.');
                return [
                    'dir' => $finalDir,
                    'name' => $backupName,
                    'files' => 0,
                    'dirs' => 0,
                    'symlinks' => 0,
                    'bytes' => bk_dirSize($finalDir),
                    'existing' => true,
                ];
            }

            /*
             * Forced: keep today's folder exactly as it is and write a second
             * one beside it, named like a pre-restore snapshot minus the random
             * suffix.
             */
            $backupName = date('Y-m-d_H-i-s');
            $finalDir = $backupRoot . '/' . $backupName;
            $say('Backup for ' . $today . ' already exists. Forcing a second backup: ' . $backupName);

            if (is_dir($finalDir) && is_file($finalDir . '/backup-complete.json')) {
                throw new RuntimeException('A forced backup named "' . $backupName . '" already exists.');
            }
        }

        $tempDir = $backupRoot . '/.tmp-' . $backupName . '-' . getmypid();

        if (is_dir($finalDir)) bk_removeTree($finalDir);
        if (is_dir($tempDir)) bk_removeTree($tempDir);
        bk_ensureDir($tempDir, 0750);

        try {
            $localConfig = $root . '/lib/config.local.php';
            if (is_file($localConfig)) require_once $localConfig;

            $dataDir = defined('TRAX_DATA_DIR') && is_string(TRAX_DATA_DIR) && TRAX_DATA_DIR !== '' ? rtrim(TRAX_DATA_DIR, '/\\') : $root;
            $uploadDir = defined('TRAX_UPLOAD_DIR') && is_string(TRAX_UPLOAD_DIR) && TRAX_UPLOAD_DIR !== '' ? rtrim(TRAX_UPLOAD_DIR, '/\\') : $root . '/uploads';
            $docDir = defined('TRAX_DOC_DIR') && is_string(TRAX_DOC_DIR) && TRAX_DOC_DIR !== '' ? rtrim(TRAX_DOC_DIR, '/\\') : $root . '/documents';

            $files = 0; $dirs = 0; $symlinks = 0;

            foreach (['data.json','data.json.bak','checkout.json','users.json'] as $name) {
                $src = $dataDir . '/' . $name;
                if (!is_file($src) && $dataDir !== $root && is_file($root . '/' . $name)) $src = $root . '/' . $name;
                if (is_file($src)) { $say('Backing up: ' . $src); $files += bk_copyFileSafe($src, $tempDir . '/data/' . $name); }
            }

            if (is_file($localConfig)) $files += bk_copyFileSafe($localConfig, $tempDir . '/config/config.local.php');

            foreach (['logo.png','favicon.png'] as $name) {
                $src = $root . '/' . $name;
                if (is_file($src)) $files += bk_copyFileSafe($src, $tempDir . '/branding/' . $name);
            }

            if (is_dir($uploadDir)) {
                $say('Backing up uploads: ' . $uploadDir);
                $s = bk_copyDirectorySafe($uploadDir, $tempDir . '/uploads');
                $files += $s['files']; $dirs += $s['dirs']; $symlinks += $s['skipped_symlinks'];
            }

            if (is_dir($docDir)) {
                $say('Backing up documents: ' . $docDir);
                $s = bk_copyDirectorySafe($docDir, $tempDir . '/documents');
                $files += $s['files']; $dirs += $s['dirs']; $symlinks += $s['skipped_symlinks'];
            }

            $manifest = [
                'backup_date' => $today,
                'created_at' => date(DATE_ATOM),
                'application_root' => $root,
                'backup_root' => $backupRoot,
                'files_copied' => $files,
                'directories_copied' => $dirs,
                'skipped_symlinks' => $symlinks,
            ];
            file_put_contents($tempDir . '/backup-complete.json', json_encode($manifest, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES) . PHP_EOL, LOCK_EX);

            if (!@rename($tempDir, $finalDir)) throw new RuntimeException('Could not finalize backup directory: ' . $finalDir);
        } catch (Throwable $e) {
            if (is_dir($tempDir)) bk_removeTree($tempDir);
            throw $e;
        }

        $say('Backup complete: ' . $files . ' file(s).');

        return [
            'dir' => $finalDir,
            'name' => $backupName,
            'files' => $files,
            'dirs' => $dirs,
            'symlinks' => $symlinks,
            'bytes' => bk_dirSize($finalDir),
            'existing' => false,
        ];
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/*
 * A direct HTTP hit on this file is still refused, exactly as before. The test
 * is "is this file the request target", so an include from restore.php falls
 * through it.
 */
if (PHP_SAPI !== 'cli' && realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=UTF-8');
    exit("Forbidden. Run backup.php via CLI/cron only.\n");
}

/*
 * CLI runner. Guarded so that require 'backup.php' from restore.php defines the
 * functions above and does nothing else.
 */
if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === __FILE__) {
    date_default_timezone_set('Europe/Berlin');

    $out = static function (string $message): void {
        fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . '] ' . $message . PHP_EOL);
    };

    $fail = static function (string $message, int $code = 1): never {
        fwrite(STDERR, '[' . date('Y-m-d H:i:s') . '] ERROR: ' . $message . PHP_EOL);
        exit($code);
    };

    $root = realpath(__DIR__) ?: __DIR__;
    $siteRoot = dirname($root);
    $backupRoot = $siteRoot . DIRECTORY_SEPARATOR . 'backup';

    $force = in_array('--force', array_slice($argv, 1), true);

    try {
        trax_run_backup($root, $backupRoot, $out, $force);
    } catch (Throwable $e) {
        $fail($e->getMessage(), $e->getCode() === 2 ? 2 : 1);
    }
}
