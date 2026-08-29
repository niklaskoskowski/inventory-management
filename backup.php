<?php
declare(strict_types=1);

/**
 * Inventory Management daily backup
 *
 * Intended to be run from cron / CLI only.
 *
 * Backup destination:
 *   ./backup/YYYY-MM-DD/
 *
 * Persistent content backed up:
 *   - data.json
 *   - data.json.bak
 *   - checkout.json
 *   - users.json
 *   - lib/config.local.php
 *   - uploads/
 *   - documents/
 *   - logo.png
 *   - favicon.png
 *
 * If config.local.php defines TRAX_DATA_DIR, TRAX_UPLOAD_DIR or TRAX_DOC_DIR,
 * those locations are used where applicable.
 */

date_default_timezone_set('Europe/Berlin');

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=UTF-8');
    exit("Forbidden. This backup script may only be run from CLI/cron.\n");
}

$root = __DIR__;
$backupRoot = $root . '/backup';
$today = date('Y-m-d');
$finalDir = $backupRoot . '/' . $today;
$tempDir = $backupRoot . '/.tmp-' . $today . '-' . getmypid();
$lockPath = $backupRoot . '/.backup.lock';

function out(string $message): void
{
    fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . '] ' . $message . PHP_EOL);
}

function fail(string $message, int $code = 1): never
{
    fwrite(STDERR, '[' . date('Y-m-d H:i:s') . '] ERROR: ' . $message . PHP_EOL);
    exit($code);
}

function ensureDir(string $path, int $mode = 0750): void
{
    if (is_dir($path)) {
        return;
    }

    if (!@mkdir($path, $mode, true) && !is_dir($path)) {
        throw new RuntimeException('Could not create directory: ' . $path);
    }
}

function copyFileSafe(string $source, string $destination): int
{
    if (!is_file($source)) {
        return 0;
    }

    ensureDir(dirname($destination));

    if (!@copy($source, $destination)) {
        throw new RuntimeException('Could not copy file: ' . $source);
    }

    @chmod($destination, 0640);

    return 1;
}

/**
 * Recursively copy a directory without following symlinks.
 *
 * @return array{files:int,dirs:int,skipped_symlinks:int}
 */
function copyDirectorySafe(string $source, string $destination): array
{
    $stats = [
        'files' => 0,
        'dirs' => 0,
        'skipped_symlinks' => 0,
    ];

    if (!is_dir($source)) {
        return $stats;
    }

    ensureDir($destination);
    $stats['dirs']++;

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator(
            $source,
            FilesystemIterator::SKIP_DOTS
        ),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($iterator as $item) {
        $sourcePath = $item->getPathname();
        $relativePath = substr($sourcePath, strlen(rtrim($source, DIRECTORY_SEPARATOR)) + 1);
        $destinationPath = $destination . DIRECTORY_SEPARATOR . $relativePath;

        if ($item->isLink()) {
            $stats['skipped_symlinks']++;
            out('Skipping symlink: ' . $sourcePath);
            continue;
        }

        if ($item->isDir()) {
            ensureDir($destinationPath);
            $stats['dirs']++;
            continue;
        }

        if ($item->isFile()) {
            ensureDir(dirname($destinationPath));

            if (!@copy($sourcePath, $destinationPath)) {
                throw new RuntimeException('Could not copy file: ' . $sourcePath);
            }

            @chmod($destinationPath, 0640);
            $stats['files']++;
        }
    }

    return $stats;
}

function removeTree(string $path): void
{
    if (!file_exists($path)) {
        return;
    }

    if (is_file($path) || is_link($path)) {
        @unlink($path);
        return;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($iterator as $item) {
        if ($item->isDir() && !$item->isLink()) {
            @rmdir($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }

    @rmdir($path);
}

function canonicalExistingPath(string $path): string
{
    $real = realpath($path);
    return $real !== false ? $real : $path;
}

try {
    ensureDir($backupRoot, 0750);

    // Block all direct web access to backup contents.
    $htaccess = $backupRoot . '/.htaccess';
    if (!is_file($htaccess)) {
        $rules = <<<HTACCESS
Options -Indexes

<IfModule mod_authz_core.c>
    Require all denied
</IfModule>

<IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
</IfModule>
HTACCESS;

        if (@file_put_contents($htaccess, $rules . PHP_EOL, LOCK_EX) === false) {
            throw new RuntimeException('Could not create backup/.htaccess');
        }
        @chmod($htaccess, 0640);
    }

    $lockHandle = @fopen($lockPath, 'c+');
    if ($lockHandle === false) {
        throw new RuntimeException('Could not open backup lock file.');
    }

    if (!flock($lockHandle, LOCK_EX | LOCK_NB)) {
        fclose($lockHandle);
        fail('Another backup process is already running.', 2);
    }

    // A completed backup for today already exists: do nothing.
    if (is_dir($finalDir) && is_file($finalDir . '/backup-complete.json')) {
        out('Backup for ' . $today . ' already exists. Nothing to do.');
        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);
        exit(0);
    }

    // Clean up an incomplete backup from a previous failed run today.
    if (is_dir($finalDir)) {
        out('Removing incomplete backup directory from an earlier run today.');
        removeTree($finalDir);
    }

    if (is_dir($tempDir)) {
        removeTree($tempDir);
    }

    ensureDir($tempDir, 0750);

    // Read local path overrides without loading the complete application/auth stack.
    $localConfig = $root . '/lib/config.local.php';
    if (is_file($localConfig)) {
        require_once $localConfig;
    }

    $dataDir = defined('TRAX_DATA_DIR') && is_string(TRAX_DATA_DIR) && TRAX_DATA_DIR !== ''
        ? rtrim(TRAX_DATA_DIR, '/\\')
        : $root;

    $uploadDir = defined('TRAX_UPLOAD_DIR') && is_string(TRAX_UPLOAD_DIR) && TRAX_UPLOAD_DIR !== ''
        ? rtrim(TRAX_UPLOAD_DIR, '/\\')
        : $root . '/uploads';

    $docDir = defined('TRAX_DOC_DIR') && is_string(TRAX_DOC_DIR) && TRAX_DOC_DIR !== ''
        ? rtrim(TRAX_DOC_DIR, '/\\')
        : $root . '/documents';

    out('Starting daily backup.');
    out('Destination: ' . $finalDir);

    $filesCopied = 0;
    $dirsCopied = 0;
    $skippedSymlinks = 0;
    $sources = [];

    // JSON / runtime data.
    $dataFiles = [
        'data.json',
        'data.json.bak',
        'checkout.json',
        'users.json',
    ];

    foreach ($dataFiles as $filename) {
        $source = $dataDir . '/' . $filename;

        // Compatibility: if a configured data directory does not contain a
        // particular legacy file, also check the application root.
        if (!is_file($source) && $dataDir !== $root && is_file($root . '/' . $filename)) {
            $source = $root . '/' . $filename;
        }

        if (!is_file($source)) {
            out('Not present, skipping: ' . $filename);
            continue;
        }

        out('Backing up: ' . $source);
        $filesCopied += copyFileSafe($source, $tempDir . '/data/' . $filename);
        $sources[] = canonicalExistingPath($source);
    }

    // Local installation configuration.
    if (is_file($localConfig)) {
        out('Backing up: ' . $localConfig);
        $filesCopied += copyFileSafe($localConfig, $tempDir . '/config/config.local.php');
        $sources[] = canonicalExistingPath($localConfig);
    } else {
        out('Not present, skipping: lib/config.local.php');
    }

    // Runtime branding.
    foreach (['logo.png', 'favicon.png'] as $filename) {
        $source = $root . '/' . $filename;
        if (!is_file($source)) {
            continue;
        }

        out('Backing up: ' . $source);
        $filesCopied += copyFileSafe($source, $tempDir . '/branding/' . $filename);
        $sources[] = canonicalExistingPath($source);
    }

    // User uploads.
    if (is_dir($uploadDir)) {
        out('Backing up uploads: ' . $uploadDir);
        $stats = copyDirectorySafe($uploadDir, $tempDir . '/uploads');
        $filesCopied += $stats['files'];
        $dirsCopied += $stats['dirs'];
        $skippedSymlinks += $stats['skipped_symlinks'];
        $sources[] = canonicalExistingPath($uploadDir);
    } else {
        out('Upload directory not present, skipping: ' . $uploadDir);
    }

    // User documents.
    if (is_dir($docDir)) {
        out('Backing up documents: ' . $docDir);
        $stats = copyDirectorySafe($docDir, $tempDir . '/documents');
        $filesCopied += $stats['files'];
        $dirsCopied += $stats['dirs'];
        $skippedSymlinks += $stats['skipped_symlinks'];
        $sources[] = canonicalExistingPath($docDir);
    } else {
        out('Document directory not present, skipping: ' . $docDir);
    }

    $manifest = [
        'backup_date' => $today,
        'created_at' => date(DATE_ATOM),
        'application_root' => canonicalExistingPath($root),
        'files_copied' => $filesCopied,
        'directories_copied' => $dirsCopied,
        'skipped_symlinks' => $skippedSymlinks,
        'sources' => $sources,
        'php_version' => PHP_VERSION,
        'hostname' => gethostname() ?: null,
    ];

    $manifestJson = json_encode(
        $manifest,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );

    if ($manifestJson === false) {
        throw new RuntimeException('Could not encode backup manifest.');
    }

    if (@file_put_contents($tempDir . '/backup-complete.json', $manifestJson . PHP_EOL, LOCK_EX) === false) {
        throw new RuntimeException('Could not write backup manifest.');
    }

    @chmod($tempDir . '/backup-complete.json', 0640);

    // Atomic publish: incomplete backups remain hidden as .tmp-*.
    if (!@rename($tempDir, $finalDir)) {
        throw new RuntimeException('Could not finalize backup directory.');
    }

    out(
        'Backup complete: '
        . $filesCopied . ' file(s), '
        . $dirsCopied . ' director'
        . ($dirsCopied === 1 ? 'y' : 'ies')
        . '.'
    );

    if ($skippedSymlinks > 0) {
        out('Skipped symlink(s): ' . $skippedSymlinks);
    }

    flock($lockHandle, LOCK_UN);
    fclose($lockHandle);
    exit(0);

} catch (Throwable $e) {
    if (isset($tempDir) && is_dir($tempDir)) {
        removeTree($tempDir);
    }

    fail($e->getMessage());
}
