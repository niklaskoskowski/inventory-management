<?php
declare(strict_types=1);

date_default_timezone_set('Europe/Berlin');

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=UTF-8');
    exit("Forbidden. Run backup.php via CLI/cron only.\n");
}

$root = realpath(__DIR__) ?: __DIR__;
$siteRoot = dirname($root);
$backupRoot = $siteRoot . DIRECTORY_SEPARATOR . 'backup';
$today = date('Y-m-d');
$finalDir = $backupRoot . '/' . $today;
$tempDir = $backupRoot . '/.tmp-' . $today . '-' . getmypid();
$lockPath = $backupRoot . '/.backup.lock';

function out(string $message): void {
    fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . '] ' . $message . PHP_EOL);
}

function fail(string $message, int $code = 1): never {
    fwrite(STDERR, '[' . date('Y-m-d H:i:s') . '] ERROR: ' . $message . PHP_EOL);
    exit($code);
}

function ensureDir(string $path, int $mode = 0750): void {
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

function copyFileSafe(string $source, string $destination): int {
    if (!is_file($source)) return 0;
    ensureDir(dirname($destination));
    if (!@copy($source, $destination)) {
        $last = error_get_last();
        throw new RuntimeException('Could not copy file: ' . $source . ($last && isset($last['message']) ? "\n" . $last['message'] : ''));
    }
    @chmod($destination, 0640);
    return 1;
}

function copyDirectorySafe(string $source, string $destination): array {
    $stats = ['files' => 0, 'dirs' => 0, 'skipped_symlinks' => 0];
    if (!is_dir($source)) return $stats;
    ensureDir($destination);
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
        if ($item->isDir()) { ensureDir($destinationPath); $stats['dirs']++; continue; }
        if ($item->isFile()) {
            ensureDir(dirname($destinationPath));
            if (!@copy($sourcePath, $destinationPath)) throw new RuntimeException('Could not copy file: ' . $sourcePath);
            @chmod($destinationPath, 0640);
            $stats['files']++;
        }
    }
    return $stats;
}

function removeTree(string $path): void {
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

try {
    out('Application root: ' . $root);
    out('Backup root: ' . $backupRoot);
    $parent = dirname($backupRoot);
    out('Backup parent exists: ' . (is_dir($parent) ? 'yes' : 'no'));
    out('Backup parent writable: ' . (is_writable($parent) ? 'yes' : 'no'));

    if (!is_dir($parent)) throw new RuntimeException('Backup parent does not exist: ' . $parent);
    if (!is_writable($parent) && !is_dir($backupRoot)) throw new RuntimeException('Backup parent is not writable: ' . $parent);

    ensureDir($backupRoot, 0750);

    $lock = @fopen($lockPath, 'c+');
    if (!$lock) throw new RuntimeException('Could not open lock file: ' . $lockPath);
    if (!flock($lock, LOCK_EX | LOCK_NB)) fail('Another backup is already running.', 2);

    if (is_dir($finalDir) && is_file($finalDir . '/backup-complete.json')) {
        out('Backup for ' . $today . ' already exists. Nothing to do.');
        flock($lock, LOCK_UN); fclose($lock); exit(0);
    }

    if (is_dir($finalDir)) removeTree($finalDir);
    if (is_dir($tempDir)) removeTree($tempDir);
    ensureDir($tempDir, 0750);

    $localConfig = $root . '/lib/config.local.php';
    if (is_file($localConfig)) require_once $localConfig;

    $dataDir = defined('TRAX_DATA_DIR') && is_string(TRAX_DATA_DIR) && TRAX_DATA_DIR !== '' ? rtrim(TRAX_DATA_DIR, '/\\') : $root;
    $uploadDir = defined('TRAX_UPLOAD_DIR') && is_string(TRAX_UPLOAD_DIR) && TRAX_UPLOAD_DIR !== '' ? rtrim(TRAX_UPLOAD_DIR, '/\\') : $root . '/uploads';
    $docDir = defined('TRAX_DOC_DIR') && is_string(TRAX_DOC_DIR) && TRAX_DOC_DIR !== '' ? rtrim(TRAX_DOC_DIR, '/\\') : $root . '/documents';

    $files = 0; $dirs = 0; $symlinks = 0;

    foreach (['data.json','data.json.bak','checkout.json','users.json'] as $name) {
        $src = $dataDir . '/' . $name;
        if (!is_file($src) && $dataDir !== $root && is_file($root . '/' . $name)) $src = $root . '/' . $name;
        if (is_file($src)) { out('Backing up: ' . $src); $files += copyFileSafe($src, $tempDir . '/data/' . $name); }
    }

    if (is_file($localConfig)) $files += copyFileSafe($localConfig, $tempDir . '/config/config.local.php');

    foreach (['logo.png','favicon.png'] as $name) {
        $src = $root . '/' . $name;
        if (is_file($src)) $files += copyFileSafe($src, $tempDir . '/branding/' . $name);
    }

    if (is_dir($uploadDir)) {
        out('Backing up uploads: ' . $uploadDir);
        $s = copyDirectorySafe($uploadDir, $tempDir . '/uploads');
        $files += $s['files']; $dirs += $s['dirs']; $symlinks += $s['skipped_symlinks'];
    }

    if (is_dir($docDir)) {
        out('Backing up documents: ' . $docDir);
        $s = copyDirectorySafe($docDir, $tempDir . '/documents');
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

    out('Backup complete: ' . $files . ' file(s).');
    flock($lock, LOCK_UN); fclose($lock);
} catch (Throwable $e) {
    if (isset($tempDir) && is_dir($tempDir)) removeTree($tempDir);
    fail($e->getMessage());
}
