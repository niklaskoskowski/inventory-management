<?php
declare(strict_types=1);

/**
 * Inventory Management Restore UI
 *
 * Location:
 *   .../httpdocs/restore.php
 *
 * Backups:
 *   .../backup/YYYY-MM-DD/
 *
 * Uses the same authentication gate as admin.php.
 */

date_default_timezone_set('Europe/Berlin');

$root = realpath(__DIR__) ?: __DIR__;
$siteRoot = dirname($root);
$backupRoot = $siteRoot . DIRECTORY_SEPARATOR . 'backup';

require_once $root . '/lib/config.php';
require_once $root . '/lib/auth.php';

// Defines trax_run_backup() and nothing else when included; its CLI runner is
// guarded and does not fire from here.
require_once $root . '/backup.php';

// Set before the gate, so the redirect response carries it as well.
header('X-Robots-Tag: noindex, nofollow');

trax_require_login('html');

if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
}

if (empty($_SESSION['trax_restore_csrf'])) {
    $_SESSION['trax_restore_csrf'] = bin2hex(random_bytes(32));
}

$csrf = (string)$_SESSION['trax_restore_csrf'];

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function flashSet(string $type, string $message): void
{
    $_SESSION['trax_restore_flash'] = [
        'type' => $type,
        'message' => $message,
    ];
}

function flashGet(): ?array
{
    $flash = $_SESSION['trax_restore_flash'] ?? null;
    unset($_SESSION['trax_restore_flash']);
    return is_array($flash) ? $flash : null;
}

/*
 * Two permission sets. Private data (data.json, checkout.json, users.json,
 * documents/, lib/config.local.php) is only ever read by PHP, so it stays
 * 0640 in 0750 directories. uploads/ is different: the web server hands those
 * files out itself, and on a host where it runs as a different user than PHP
 * a 0640 photo answers 403. lib/photo.php writes 0755/0644 there, and a
 * restore must not undo that.
 */
const RESTORE_PRIVATE_MODES = ['dir' => 0750, 'file' => 0640];
const RESTORE_PUBLIC_MODES = ['dir' => 0755, 'file' => 0644];

function ensureDir(string $path, int $mode = 0750): void
{
    if (is_dir($path)) {
        return;
    }

    if (!@mkdir($path, $mode, true) && !is_dir($path)) {
        $last = error_get_last();
        throw new RuntimeException(
            'Could not create directory: ' . $path .
            ($last && isset($last['message']) ? ' — ' . $last['message'] : '')
        );
    }
}

function removeTree(string $path): void
{
    if (!file_exists($path)) {
        return;
    }

    if (is_file($path) || is_link($path)) {
        if (!@unlink($path)) {
            throw new RuntimeException('Could not remove file: ' . $path);
        }
        return;
    }

    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($it as $item) {
        $p = $item->getPathname();

        if ($item->isDir() && !$item->isLink()) {
            if (!@rmdir($p)) {
                throw new RuntimeException('Could not remove directory: ' . $p);
            }
        } else {
            if (!@unlink($p)) {
                throw new RuntimeException('Could not remove file: ' . $p);
            }
        }
    }

    if (!@rmdir($path)) {
        throw new RuntimeException('Could not remove directory: ' . $path);
    }
}

function copyFileSafe(string $source, string $destination, array $modes = RESTORE_PRIVATE_MODES): int
{
    if (!is_file($source)) {
        return 0;
    }

    ensureDir(dirname($destination), $modes['dir']);

    if (!@copy($source, $destination)) {
        $last = error_get_last();
        throw new RuntimeException(
            'Could not copy ' . $source . ' to ' . $destination .
            ($last && isset($last['message']) ? ' — ' . $last['message'] : '')
        );
    }

    @chmod($destination, $modes['file']);
    return 1;
}

/**
 * Copy a complete directory tree without following symlinks.
 *
 * @return array{files:int,dirs:int,symlinks:int}
 */
function copyDirectorySafe(string $source, string $destination, array $modes = RESTORE_PRIVATE_MODES): array
{
    $stats = ['files' => 0, 'dirs' => 0, 'symlinks' => 0];

    if (!is_dir($source)) {
        return $stats;
    }

    ensureDir($destination, $modes['dir']);
    @chmod($destination, $modes['dir']);
    $stats['dirs']++;

    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    $sourceBase = rtrim($source, DIRECTORY_SEPARATOR);

    foreach ($it as $item) {
        $sourcePath = $item->getPathname();
        $relative = substr($sourcePath, strlen($sourceBase) + 1);
        $destPath = $destination . DIRECTORY_SEPARATOR . $relative;

        if ($item->isLink()) {
            $stats['symlinks']++;
            continue;
        }

        if ($item->isDir()) {
            ensureDir($destPath, $modes['dir']);
            @chmod($destPath, $modes['dir']);
            $stats['dirs']++;
            continue;
        }

        if ($item->isFile()) {
            ensureDir(dirname($destPath), $modes['dir']);

            if (!@copy($sourcePath, $destPath)) {
                $last = error_get_last();
                throw new RuntimeException(
                    'Could not copy ' . $sourcePath .
                    ($last && isset($last['message']) ? ' — ' . $last['message'] : '')
                );
            }

            @chmod($destPath, $modes['file']);
            $stats['files']++;
        }
    }

    return $stats;
}

/**
 * Force the whole uploads tree to 0755 dirs / 0644 files.
 *
 * Runs over everything that is there, not only over what a restore just
 * copied: a folder uploaded by FTP or unpacked from a tarball arrives with
 * whatever mode the transfer felt like, and a 0640 photo is a 403 wherever
 * the web server is not the PHP user. chmod failures are counted, not
 * thrown - on a shared host the files may belong to somebody else, and the
 * ones we can fix should still get fixed.
 *
 * @return array{files:int,dirs:int,changed:int,failed:int}
 */
function fixUploadPermissions(string $uploadDir): array
{
    $stats = ['files' => 0, 'dirs' => 0, 'changed' => 0, 'failed' => 0];

    if (!is_dir($uploadDir)) {
        return $stats;
    }

    $apply = static function (string $path, int $want, array &$stats): void {
        $current = @fileperms($path);

        if ($current !== false && ($current & 0777) === $want) {
            return;
        }

        if (@chmod($path, $want)) {
            $stats['changed']++;
        } else {
            $stats['failed']++;
        }
    };

    $stats['dirs']++;
    $apply($uploadDir, RESTORE_PUBLIC_MODES['dir'], $stats);

    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($uploadDir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    foreach ($it as $item) {
        if ($item->isLink()) {
            continue;
        }

        if ($item->isDir()) {
            $stats['dirs']++;
            $apply($item->getPathname(), RESTORE_PUBLIC_MODES['dir'], $stats);
            continue;
        }

        if ($item->isFile()) {
            $stats['files']++;
            $apply($item->getPathname(), RESTORE_PUBLIC_MODES['file'], $stats);
        }
    }

    return $stats;
}

function dirSize(string $path): int
{
    if (!is_dir($path)) {
        return 0;
    }

    $size = 0;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($it as $item) {
        if ($item->isFile() && !$item->isLink()) {
            $size += (int)$item->getSize();
        }
    }

    return $size;
}

function formatBytes(int $bytes): string
{
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $i = 0;
    $value = (float)$bytes;

    while ($value >= 1024 && $i < count($units) - 1) {
        $value /= 1024;
        $i++;
    }

    return ($i === 0 ? (string)(int)$value : number_format($value, 1)) . ' ' . $units[$i];
}

function readManifest(string $dir): ?array
{
    $file = $dir . '/backup-complete.json';
    if (!is_file($file)) {
        return null;
    }

    $raw = @file_get_contents($file);
    if ($raw === false) {
        return null;
    }

    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function listBackups(string $backupRoot): array
{
    if (!is_dir($backupRoot)) {
        return [];
    }

    $rows = [];

    foreach (new DirectoryIterator($backupRoot) as $entry) {
        if ($entry->isDot() || !$entry->isDir()) {
            continue;
        }

        $name = $entry->getFilename();

        if (str_starts_with($name, '.')) {
            continue;
        }

        $dir = $entry->getPathname();
        $manifest = readManifest($dir);

        if ($manifest === null) {
            continue;
        }

        $rows[] = [
            'name' => $name,
            'dir' => $dir,
            'manifest' => $manifest,
            'size' => dirSize($dir),
            'mtime' => $entry->getMTime(),
            'has_data' => is_dir($dir . '/data'),
            'has_uploads' => is_dir($dir . '/uploads'),
            'has_documents' => is_dir($dir . '/documents'),
            'has_branding' => is_dir($dir . '/branding'),
            'has_config' => is_file($dir . '/config/config.local.php'),
        ];
    }

    usort($rows, static function (array $a, array $b): int {
        $ta = strtotime((string)($a['manifest']['created_at'] ?? '')) ?: $a['mtime'];
        $tb = strtotime((string)($b['manifest']['created_at'] ?? '')) ?: $b['mtime'];
        return $tb <=> $ta;
    });

    return $rows;
}

function resolveBackupByName(string $backupRoot, string $name): string
{
    if ($name === '' || str_contains($name, '/') || str_contains($name, '\\') || str_contains($name, '..')) {
        throw new RuntimeException('Invalid backup selection.');
    }

    $candidate = $backupRoot . DIRECTORY_SEPARATOR . $name;
    $realRoot = realpath($backupRoot);
    $realCandidate = realpath($candidate);

    if ($realRoot === false || $realCandidate === false || !is_dir($realCandidate)) {
        throw new RuntimeException('Selected backup does not exist.');
    }

    $prefix = rtrim($realRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;

    if (!str_starts_with($realCandidate . DIRECTORY_SEPARATOR, $prefix)) {
        throw new RuntimeException('Invalid backup path.');
    }

    if (readManifest($realCandidate) === null) {
        throw new RuntimeException('Selected backup is incomplete or invalid.');
    }

    return $realCandidate;
}

function runtimePaths(string $root): array
{
    $localConfig = $root . '/lib/config.local.php';

    /*
     * config.php is already loaded by the application. Use configured
     * runtime paths where available, otherwise fall back to the app root.
     */
    $dataDir = defined('TRAX_DATA_DIR') && is_string(TRAX_DATA_DIR) && TRAX_DATA_DIR !== ''
        ? rtrim(TRAX_DATA_DIR, '/\\')
        : $root;

    $uploadDir = defined('TRAX_UPLOAD_DIR') && is_string(TRAX_UPLOAD_DIR) && TRAX_UPLOAD_DIR !== ''
        ? rtrim(TRAX_UPLOAD_DIR, '/\\')
        : $root . '/uploads';

    $docDir = defined('TRAX_DOC_DIR') && is_string(TRAX_DOC_DIR) && TRAX_DOC_DIR !== ''
        ? rtrim(TRAX_DOC_DIR, '/\\')
        : $root . '/documents';

    return [
        'data_dir' => $dataDir,
        'upload_dir' => $uploadDir,
        'doc_dir' => $docDir,
        'config_file' => $localConfig,
        'logo_file' => $root . '/logo.png',
        'favicon_file' => $root . '/favicon.png',
    ];
}

/**
 * Create a pre-restore snapshot of the selected live categories.
 */
function createPreRestoreSnapshot(
    string $backupRoot,
    string $root,
    array $paths,
    array $categories,
    string $sourceBackup
): string {
    ensureDir($backupRoot);

    $name = 'pre-restore-' . date('Y-m-d_H-i-s') . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
    $dir = $backupRoot . DIRECTORY_SEPARATOR . $name;
    ensureDir($dir);

    $filesCopied = 0;
    $dirsCopied = 0;

    $want = array_fill_keys($categories, true);

    if (isset($want['data'])) {
        foreach (['data.json', 'data.json.bak', 'checkout.json', 'users.json'] as $filename) {
            $source = $paths['data_dir'] . '/' . $filename;
            if (!is_file($source) && $paths['data_dir'] !== $root && is_file($root . '/' . $filename)) {
                $source = $root . '/' . $filename;
            }
            $filesCopied += copyFileSafe($source, $dir . '/data/' . $filename);
        }
    }

    if (isset($want['uploads']) && is_dir($paths['upload_dir'])) {
        $stats = copyDirectorySafe($paths['upload_dir'], $dir . '/uploads');
        $filesCopied += $stats['files'];
        $dirsCopied += $stats['dirs'];
    }

    if (isset($want['documents']) && is_dir($paths['doc_dir'])) {
        $stats = copyDirectorySafe($paths['doc_dir'], $dir . '/documents');
        $filesCopied += $stats['files'];
        $dirsCopied += $stats['dirs'];
    }

    if (isset($want['branding'])) {
        $filesCopied += copyFileSafe($paths['logo_file'], $dir . '/branding/logo.png');
        $filesCopied += copyFileSafe($paths['favicon_file'], $dir . '/branding/favicon.png');
    }

    if (isset($want['config'])) {
        $filesCopied += copyFileSafe($paths['config_file'], $dir . '/config/config.local.php');
    }

    $manifest = [
        'backup_date' => date('Y-m-d'),
        'created_at' => date(DATE_ATOM),
        'type' => 'pre-restore',
        'source_backup' => $sourceBackup,
        'application_root' => $root,
        'files_copied' => $filesCopied,
        'directories_copied' => $dirsCopied,
        'categories' => array_values($categories),
    ];

    $json = json_encode(
        $manifest,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
    );

    if ($json === false || @file_put_contents($dir . '/backup-complete.json', $json . PHP_EOL, LOCK_EX) === false) {
        throw new RuntimeException('Could not write pre-restore backup manifest.');
    }

    return $name;
}

function restoreData(string $backupDir, string $root, array $paths): int
{
    $sourceDir = $backupDir . '/data';
    if (!is_dir($sourceDir)) {
        throw new RuntimeException('This backup contains no data snapshot.');
    }

    $count = 0;

    foreach (['data.json', 'data.json.bak', 'checkout.json', 'users.json'] as $filename) {
        $source = $sourceDir . '/' . $filename;
        if (!is_file($source)) {
            continue;
        }

        $destination = $paths['data_dir'] . '/' . $filename;

        /*
         * Compatibility with legacy installations where some JSON files
         * still live in the application root.
         */
        if (
            $paths['data_dir'] !== $root &&
            !is_file($destination) &&
            is_file($root . '/' . $filename)
        ) {
            $destination = $root . '/' . $filename;
        }

        $count += copyFileSafe($source, $destination);
    }

    return $count;
}

function restoreDirectorySnapshot(string $source, string $destination, array $modes = RESTORE_PRIVATE_MODES): int
{
    if (!is_dir($source)) {
        throw new RuntimeException('Backup section not present: ' . basename($source));
    }

    if (is_dir($destination)) {
        removeTree($destination);
    } elseif (file_exists($destination)) {
        throw new RuntimeException('Restore destination is not a directory: ' . $destination);
    }

    $stats = copyDirectorySafe($source, $destination, $modes);
    return $stats['files'];
}

function restoreBranding(string $backupDir, array $paths): int
{
    $sourceDir = $backupDir . '/branding';
    if (!is_dir($sourceDir)) {
        throw new RuntimeException('This backup contains no branding snapshot.');
    }

    $count = 0;

    foreach ([
        'logo.png' => $paths['logo_file'],
        'favicon.png' => $paths['favicon_file'],
    ] as $filename => $destination) {
        $source = $sourceDir . '/' . $filename;
        if (is_file($source)) {
            $count += copyFileSafe($source, $destination);
        }
    }

    return $count;
}

function restoreConfig(string $backupDir, array $paths): int
{
    $source = $backupDir . '/config/config.local.php';

    if (!is_file($source)) {
        throw new RuntimeException('This backup contains no local configuration.');
    }

    return copyFileSafe($source, $paths['config_file']);
}

$paths = runtimePaths($root);
$allowedCategories = ['data', 'uploads', 'documents', 'branding', 'config'];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $redirectTo = strtok((string)($_SERVER['REQUEST_URI'] ?? 'restore.php'), '?');

    try {
        $postedCsrf = (string)($_POST['csrf'] ?? '');
        if (!hash_equals($csrf, $postedCsrf)) {
            throw new RuntimeException('Security token expired. Reload the page and try again.');
        }

        $action = (string)($_POST['action'] ?? 'restore');

        /*
         * Create a backup on the spot, with the same code and the same target
         * directory the nightly cron uses.
         */
        if ($action === 'backup') {
            $force = ($_POST['force'] ?? '') !== '';
            $result = trax_run_backup($root, $backupRoot, null, $force);

            $_SESSION['trax_restore_csrf'] = bin2hex(random_bytes(32));

            if ($result['existing']) {
                flashSet(
                    'info',
                    'A backup for "' . $result['name'] . '" already exists (' .
                    formatBytes((int)$result['bytes']) . '). Nothing was copied.'
                );
            } else {
                flashSet(
                    'success',
                    'Backup "' . $result['name'] . '" created: ' .
                    $result['files'] . ' file(s), ' . formatBytes((int)$result['bytes']) . '.'
                );
            }

            header('Location: ' . $redirectTo);
            exit;
        }

        /*
         * Repair the live uploads tree without restoring anything - for a
         * folder that arrived by FTP or from an older restore and answers 403.
         */
        if ($action === 'fixperms') {
            $stats = fixUploadPermissions($paths['upload_dir']);

            $_SESSION['trax_restore_csrf'] = bin2hex(random_bytes(32));

            $message =
                'Upload permissions checked: ' . $stats['files'] . ' file(s) and ' .
                $stats['dirs'] . ' folder(s). Permissions repaired on ' . $stats['changed'] . '.';

            if ($stats['failed'] > 0) {
                $message .= ' ' . $stats['failed'] . ' could not be changed (owned by another user).';
            }

            flashSet($stats['failed'] > 0 ? 'warning' : 'success', $message);

            header('Location: ' . $redirectTo);
            exit;
        }

        $backupName = trim((string)($_POST['backup'] ?? ''));
        $backupDir = resolveBackupByName($backupRoot, $backupName);

        $mode = (string)($_POST['mode'] ?? 'custom');
        $categories = [];

        if ($mode === 'full') {
            foreach ($allowedCategories as $category) {
                $categories[] = $category;
            }
        } else {
            $requested = $_POST['categories'] ?? [];
            if (!is_array($requested)) {
                $requested = [];
            }

            foreach ($requested as $category) {
                $category = (string)$category;
                if (in_array($category, $allowedCategories, true)) {
                    $categories[] = $category;
                }
            }

            $categories = array_values(array_unique($categories));
        }

        if ($categories === []) {
            throw new RuntimeException('Select at least one restore category.');
        }

        if ((string)($_POST['confirm'] ?? '') !== 'RESTORE') {
            throw new RuntimeException('Type RESTORE in the confirmation field.');
        }

        ensureDir($backupRoot);

        $lockPath = $backupRoot . '/.restore.lock';
        $lockHandle = @fopen($lockPath, 'c+');

        if ($lockHandle === false) {
            throw new RuntimeException('Could not open restore lock.');
        }

        if (!flock($lockHandle, LOCK_EX | LOCK_NB)) {
            fclose($lockHandle);
            throw new RuntimeException('Another restore operation is already running.');
        }

        $preRestoreName = createPreRestoreSnapshot(
            $backupRoot,
            $root,
            $paths,
            $categories,
            $backupName
        );

        $restoredFiles = 0;
        $uploadNote = '';

        foreach ($categories as $category) {
            switch ($category) {
                case 'data':
                    $restoredFiles += restoreData($backupDir, $root, $paths);
                    break;

                case 'uploads':
                    $uploadFiles = restoreDirectorySnapshot(
                        $backupDir . '/uploads',
                        $paths['upload_dir'],
                        RESTORE_PUBLIC_MODES
                    );
                    $restoredFiles += $uploadFiles;

                    /*
                     * Sweep the whole live tree, not only what was just
                     * copied: anything already there keeps its old mode.
                     */
                    $uploadPerms = fixUploadPermissions($paths['upload_dir']);

                    $uploadNote =
                        ' uploads: ' . $uploadFiles . ' files, permissions repaired on ' .
                        $uploadPerms['changed'] . '.';

                    if ($uploadPerms['failed'] > 0) {
                        $uploadNote .= ' ' . $uploadPerms['failed'] .
                            ' could not be changed (owned by another user).';
                    }
                    break;

                case 'documents':
                    $restoredFiles += restoreDirectorySnapshot(
                        $backupDir . '/documents',
                        $paths['doc_dir']
                    );
                    break;

                case 'branding':
                    $restoredFiles += restoreBranding($backupDir, $paths);
                    break;

                case 'config':
                    $restoredFiles += restoreConfig($backupDir, $paths);
                    break;
            }
        }

        flock($lockHandle, LOCK_UN);
        fclose($lockHandle);

        $_SESSION['trax_restore_csrf'] = bin2hex(random_bytes(32));

        flashSet(
            'success',
            'Restore completed from "' . $backupName . '". ' .
            $restoredFiles . ' file(s) restored.' . $uploadNote . ' ' .
            'A safety snapshot of the previous live state was saved as "' . $preRestoreName . '".'
        );

        header('Location: ' . $redirectTo);
        exit;

    } catch (Throwable $e) {
        flashSet('danger', $e->getMessage());
        header('Location: ' . $redirectTo);
        exit;
    }
}

$flash = flashGet();
$backups = listBackups($backupRoot);

$currentBackup = $backups[0]['name'] ?? '';
?>
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Restore backup</title>

    <link
        href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
        rel="stylesheet"
        integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
        crossorigin="anonymous"
    >

    <style>
        body {
            background: #f5f6f8;
        }

        .shell {
            max-width: 1120px;
        }

        .backup-row {
            cursor: pointer;
        }

        .backup-row:hover {
            background: #f8f9fa;
        }

        .restore-card {
            position: sticky;
            top: 1.25rem;
        }

        .category-card {
            border: 1px solid var(--bs-border-color);
            border-radius: .75rem;
            padding: .9rem 1rem;
            height: 100%;
        }

        .category-card:has(.form-check-input:checked) {
            border-color: var(--bs-primary);
            background: rgba(var(--bs-primary-rgb), .04);
        }

        code.path {
            word-break: break-all;
            white-space: normal;
        }
    </style>
</head>
<body>

<div class="container shell py-4 py-lg-5">

    <div class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
            <h1 class="h3 mb-1">Restore backup</h1>
            <p class="text-secondary mb-0">
                Restore persistent Inventory data from a dated backup.
            </p>
        </div>

        <a href="admin" class="btn btn-outline-secondary">
            Back to admin
        </a>
    </div>

    <?php if ($flash): ?>
        <div class="alert alert-<?= h((string)$flash['type']) ?> alert-dismissible fade show" role="alert">
            <?= nl2br(h((string)$flash['message'])) ?>
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>
    <?php endif; ?>

    <?php if (!is_dir($backupRoot)): ?>
        <div class="alert alert-warning">
            Backup directory does not exist yet:
            <code class="path"><?= h($backupRoot) ?></code>
        </div>
    <?php endif; ?>

    <div class="row g-4">

        <div class="col-lg-7">
            <div class="card border-0 shadow-sm">
                <div class="card-header bg-white py-3">
                    <div class="d-flex justify-content-between align-items-center">
                        <strong>Available backups</strong>
                        <span class="badge text-bg-secondary"><?= count($backups) ?></span>
                    </div>
                </div>

                <div class="card-body p-0">

                    <?php if ($backups === []): ?>
                        <div class="p-4 text-secondary">
                            No completed backups were found in
                            <code class="path"><?= h($backupRoot) ?></code>.
                        </div>
                    <?php else: ?>

                        <div class="table-responsive">
                            <table class="table align-middle mb-0">
                                <thead class="table-light">
                                <tr>
                                    <th></th>
                                    <th>Backup</th>
                                    <th>Created</th>
                                    <th>Contents</th>
                                    <th class="text-end">Size</th>
                                </tr>
                                </thead>
                                <tbody>

                                <?php foreach ($backups as $i => $backup): ?>
                                    <?php
                                    $manifest = $backup['manifest'];
                                    $createdAt = (string)($manifest['created_at'] ?? '');
                                    $timestamp = strtotime($createdAt);
                                    $type = (string)($manifest['type'] ?? 'daily');
                                    ?>

                                    <tr
                                        class="backup-row"
                                        data-backup="<?= h($backup['name']) ?>"
                                    >
                                        <td class="ps-3">
                                            <input
                                                class="form-check-input backup-radio"
                                                type="radio"
                                                name="backup_visual"
                                                value="<?= h($backup['name']) ?>"
                                                <?= $i === 0 ? 'checked' : '' ?>
                                                aria-label="Select <?= h($backup['name']) ?>"
                                            >
                                        </td>

                                        <td>
                                            <div class="fw-semibold">
                                                <?= h($backup['name']) ?>
                                            </div>

                                            <?php if ($type === 'pre-restore'): ?>
                                                <span class="badge text-bg-warning mt-1">
                                                    Pre-restore safety backup
                                                </span>
                                            <?php else: ?>
                                                <span class="badge text-bg-light border text-dark mt-1">
                                                    Daily backup
                                                </span>
                                            <?php endif; ?>
                                        </td>

                                        <td class="text-nowrap">
                                            <?php if ($timestamp): ?>
                                                <?= h(date('Y-m-d H:i', $timestamp)) ?>
                                            <?php else: ?>
                                                —
                                            <?php endif; ?>
                                        </td>

                                        <td>
                                            <div class="d-flex flex-wrap gap-1">
                                                <?php if ($backup['has_data']): ?>
                                                    <span class="badge text-bg-primary">Data</span>
                                                <?php endif; ?>
                                                <?php if ($backup['has_uploads']): ?>
                                                    <span class="badge text-bg-info">Images</span>
                                                <?php endif; ?>
                                                <?php if ($backup['has_documents']): ?>
                                                    <span class="badge text-bg-secondary">Documents</span>
                                                <?php endif; ?>
                                                <?php if ($backup['has_branding']): ?>
                                                    <span class="badge text-bg-dark">Branding</span>
                                                <?php endif; ?>
                                                <?php if ($backup['has_config']): ?>
                                                    <span class="badge text-bg-warning">Config</span>
                                                <?php endif; ?>
                                            </div>
                                        </td>

                                        <td class="text-end text-nowrap">
                                            <?= h(formatBytes((int)$backup['size'])) ?>
                                        </td>
                                    </tr>
                                <?php endforeach; ?>

                                </tbody>
                            </table>
                        </div>

                    <?php endif; ?>
                </div>

                <div class="card-footer bg-white py-3">
                    <div class="d-flex flex-wrap align-items-center gap-2">
                        <form method="post" class="m-0 d-flex flex-wrap align-items-center gap-2">
                            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
                            <input type="hidden" name="action" value="backup">
                            <button type="submit" class="btn btn-outline-primary btn-sm">
                                Create backup now
                            </button>
                            <div class="form-check m-0">
                                <input class="form-check-input" type="checkbox" name="force" value="1" id="force-backup">
                                <label class="form-check-label small" for="force-backup">
                                    Force a second backup today
                                </label>
                            </div>
                        </form>

                        <form method="post" class="m-0">
                            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
                            <input type="hidden" name="action" value="fixperms">
                            <button type="submit" class="btn btn-outline-secondary btn-sm">
                                Repair upload permissions
                            </button>
                        </form>
                    </div>

                    <div class="small text-secondary mt-2 mb-0">
                        Without "Force a second backup today" a finished backup for today is left
                        alone. With it, a second one is written beside it as
                        <code>YYYY-MM-DD_HH-MM-SS</code>; nothing existing is overwritten.
                        "Repair upload permissions" sets the live <code>uploads/</code> folder to
                        0755 / 0644 without touching any data. Use it when item photos answer 403
                        after a manual copy.
                    </div>
                </div>
            </div>

            <div class="card border-0 shadow-sm mt-4">
                <div class="card-body">
                    <h2 class="h6">Paths</h2>

                    <dl class="row small mb-0">
                        <dt class="col-sm-4">Application</dt>
                        <dd class="col-sm-8"><code class="path"><?= h($root) ?></code></dd>

                        <dt class="col-sm-4">Backups</dt>
                        <dd class="col-sm-8"><code class="path"><?= h($backupRoot) ?></code></dd>

                        <dt class="col-sm-4">Data</dt>
                        <dd class="col-sm-8"><code class="path"><?= h($paths['data_dir']) ?></code></dd>

                        <dt class="col-sm-4">Images</dt>
                        <dd class="col-sm-8"><code class="path"><?= h($paths['upload_dir']) ?></code></dd>

                        <dt class="col-sm-4">Documents</dt>
                        <dd class="col-sm-8"><code class="path"><?= h($paths['doc_dir']) ?></code></dd>
                    </dl>
                </div>
            </div>
        </div>

        <div class="col-lg-5">
            <div class="card border-0 shadow-sm restore-card">
                <div class="card-body p-4">

                    <h2 class="h5 mb-1">Restore selected backup</h2>
                    <p class="text-secondary small">
                        A safety snapshot of the current live state is created first.
                    </p>

                    <?php if ($backups !== []): ?>

                        <form method="post" id="restoreForm">
                            <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
                            <input type="hidden" name="action" value="restore">
                            <input
                                type="hidden"
                                name="backup"
                                id="selectedBackup"
                                value="<?= h($currentBackup) ?>"
                            >

                            <div class="mb-3">
                                <label class="form-label fw-semibold">Restore mode</label>

                                <div class="form-check">
                                    <input
                                        class="form-check-input"
                                        type="radio"
                                        name="mode"
                                        id="modeCustom"
                                        value="custom"
                                        checked
                                    >
                                    <label class="form-check-label" for="modeCustom">
                                        Choose what to restore
                                    </label>
                                </div>

                                <div class="form-check">
                                    <input
                                        class="form-check-input"
                                        type="radio"
                                        name="mode"
                                        id="modeFull"
                                        value="full"
                                    >
                                    <label class="form-check-label" for="modeFull">
                                        Full persistent-data restore
                                    </label>
                                </div>
                            </div>

                            <div id="categoryArea">
                                <div class="row g-2 mb-4">

                                    <div class="col-12">
                                        <label class="category-card d-block">
                                            <div class="form-check">
                                                <input
                                                    class="form-check-input restore-category"
                                                    type="checkbox"
                                                    name="categories[]"
                                                    value="data"
                                                    id="catData"
                                                    checked
                                                >
                                                <span class="form-check-label fw-semibold">
                                                    Data
                                                </span>
                                            </div>
                                            <div class="small text-secondary mt-1">
                                                data.json, users.json, checkout.json and data backup
                                            </div>
                                        </label>
                                    </div>

                                    <div class="col-md-6">
                                        <label class="category-card d-block">
                                            <div class="form-check">
                                                <input
                                                    class="form-check-input restore-category"
                                                    type="checkbox"
                                                    name="categories[]"
                                                    value="uploads"
                                                    id="catUploads"
                                                >
                                                <span class="form-check-label fw-semibold">
                                                    Images
                                                </span>
                                            </div>
                                            <div class="small text-secondary mt-1">
                                                Complete uploads folder
                                            </div>
                                        </label>
                                    </div>

                                    <div class="col-md-6">
                                        <label class="category-card d-block">
                                            <div class="form-check">
                                                <input
                                                    class="form-check-input restore-category"
                                                    type="checkbox"
                                                    name="categories[]"
                                                    value="documents"
                                                    id="catDocuments"
                                                >
                                                <span class="form-check-label fw-semibold">
                                                    Documents
                                                </span>
                                            </div>
                                            <div class="small text-secondary mt-1">
                                                Complete documents folder
                                            </div>
                                        </label>
                                    </div>

                                    <div class="col-md-6">
                                        <label class="category-card d-block">
                                            <div class="form-check">
                                                <input
                                                    class="form-check-input restore-category"
                                                    type="checkbox"
                                                    name="categories[]"
                                                    value="branding"
                                                    id="catBranding"
                                                >
                                                <span class="form-check-label fw-semibold">
                                                    Branding
                                                </span>
                                            </div>
                                            <div class="small text-secondary mt-1">
                                                Logo and favicon
                                            </div>
                                        </label>
                                    </div>

                                    <div class="col-md-6">
                                        <label class="category-card d-block">
                                            <div class="form-check">
                                                <input
                                                    class="form-check-input restore-category"
                                                    type="checkbox"
                                                    name="categories[]"
                                                    value="config"
                                                    id="catConfig"
                                                >
                                                <span class="form-check-label fw-semibold">
                                                    Configuration
                                                </span>
                                            </div>
                                            <div class="small text-secondary mt-1">
                                                lib/config.local.php
                                            </div>
                                        </label>
                                    </div>

                                </div>
                            </div>

                            <div class="alert alert-warning small">
                                <strong>Images and documents are snapshot restores.</strong>
                                Their current live folders are replaced with the selected backup versions.
                            </div>

                            <div class="mb-3">
                                <label for="confirm" class="form-label fw-semibold">
                                    Type <code>RESTORE</code> to confirm
                                </label>
                                <input
                                    type="text"
                                    class="form-control"
                                    name="confirm"
                                    id="confirm"
                                    autocomplete="off"
                                    required
                                >
                            </div>

                            <button
                                class="btn btn-danger w-100"
                                type="submit"
                                id="restoreButton"
                                disabled
                            >
                                Restore backup
                            </button>
                        </form>

                    <?php else: ?>
                        <div class="alert alert-secondary mb-0">
                            No completed backup is available to restore.
                        </div>
                    <?php endif; ?>

                </div>
            </div>
        </div>

    </div>
</div>

<script
    src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"
    integrity="sha384-FKyoEForCGlyvwx9Hj09JcYn3nv7wiPVlz7YYwJrWVcXK/BmnVDxM+D2scQbITxI"
    crossorigin="anonymous"
></script>

<script>
(() => {
    const rows = document.querySelectorAll('.backup-row');
    const radios = document.querySelectorAll('.backup-radio');
    const selectedBackup = document.getElementById('selectedBackup');
    const modeCustom = document.getElementById('modeCustom');
    const modeFull = document.getElementById('modeFull');
    const categoryArea = document.getElementById('categoryArea');
    const categories = document.querySelectorAll('.restore-category');
    const confirmInput = document.getElementById('confirm');
    const restoreButton = document.getElementById('restoreButton');
    const form = document.getElementById('restoreForm');

    if (!form) {
        return;
    }

    function selectBackup(value) {
        selectedBackup.value = value;

        radios.forEach(radio => {
            radio.checked = radio.value === value;
        });
    }

    rows.forEach(row => {
        row.addEventListener('click', event => {
            if (event.target instanceof HTMLInputElement) {
                selectBackup(event.target.value);
                return;
            }

            selectBackup(row.dataset.backup || '');
        });
    });

    radios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.checked) {
                selectBackup(radio.value);
            }
        });
    });

    function updateMode() {
        const full = modeFull.checked;

        categoryArea.classList.toggle('opacity-50', full);
        categoryArea.style.pointerEvents = full ? 'none' : '';

        categories.forEach(input => {
            input.disabled = full;
        });

        updateButton();
    }

    function updateButton() {
        const confirmed = confirmInput.value.trim() === 'RESTORE';

        const hasCategory =
            modeFull.checked ||
            Array.from(categories).some(input => input.checked);

        restoreButton.disabled =
            !confirmed ||
            !hasCategory ||
            !selectedBackup.value;
    }

    modeCustom.addEventListener('change', updateMode);
    modeFull.addEventListener('change', updateMode);
    confirmInput.addEventListener('input', updateButton);

    categories.forEach(input => {
        input.addEventListener('change', updateButton);
    });

    form.addEventListener('submit', event => {
        const backup = selectedBackup.value;

        if (!window.confirm(
            'Restore "' + backup + '" now?\n\n' +
            'The selected live data will be replaced by the backup snapshot.'
        )) {
            event.preventDefault();
            return;
        }

        restoreButton.disabled = true;
        restoreButton.innerHTML =
            '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>' +
            'Restoring…';
    });

    updateMode();
})();
</script>

</body>
</html>
