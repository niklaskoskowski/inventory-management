<?php
/**
 * The one writer of lib/config.local.php.
 *
 * That file holds the deployment constants — timezone, public path, mail
 * addresses, the authentication mode. It used to have exactly one author, the
 * installer, and could therefore be generated from scratch every time. It now
 * has two: Settings → Authentication rewrites the auth constants long after the
 * install, and must not throw away the six the installer put there.
 *
 * So the file is read back, merged and rewritten as a whole. This module is
 * that read/merge/write, kept apart from lib/install.php because api.php needs
 * it and has no business loading the installer.
 *
 * Only the constants in TRAX_CONFIG_LOCAL_KEYS are ever written, in that order,
 * and every value goes through var_export() — a quote or a backslash in an
 * operator's answer becomes a literal, not a syntax error and not an escape.
 */

declare(strict_types=1);

/**
 * The whitelist. A key that is not here is dropped on read and refused on
 * write, so neither a hand-edited file nor a crafted payload can add a
 * `define()` of its own to a file the whole app then loads.
 */
const TRAX_CONFIG_LOCAL_KEYS = [
    'TRAX_TIMEZONE',
    'TRAX_PUBLIC_PATH',
    'TRAX_FALLBACK_HOST',
    'TRAX_OWNER_EMAIL',
    'TRAX_FROM_EMAIL',
    'TRAX_REPORT_FROM_EMAIL',
    'TRAX_WHATSAPP',
    'TRAX_AUTH_MODE',
    'TRAX_AUTH_INCLUDE',
    'TRAX_AUTH_LOGOUT_URL',
    'TRAX_INSTALLED',
];

/** Absolute path of the generated file. */
function trax_config_local_file(): string
{
    return __DIR__ . '/config.local.php';
}

/**
 * The constants currently written in the file, as name => value.
 *
 * Read with token_get_all() rather than by including the file: by the time
 * anything calls this, lib/config.php has already defined every one of these
 * constants and a second define() would only warn. Reading the current
 * constant() values instead is not the same thing either — those are the
 * effective values, defaults included, and writing them back would silently
 * pin defaults that were deliberately left unset.
 *
 * Only literal `define('NAME', <scalar>)` calls are recognised, which is
 * exactly what this module writes. Anything else in a hand-edited file is left
 * alone by being ignored — and therefore lost on the next write, which is why
 * the generated header says so.
 *
 * @return array<string, string|bool|int|float|null>
 */
function trax_config_local_read(): array
{
    $path = trax_config_local_file();
    if (!is_file($path) || !is_readable($path)) {
        return [];
    }

    $source = @file_get_contents($path);
    if ($source === false || $source === '') {
        return [];
    }

    $tokens = token_get_all($source);
    $values = [];

    // The shape being matched: T_STRING "define" ( 'NAME' , <literal> )
    $count = count($tokens);
    for ($i = 0; $i < $count; $i++) {
        $token = $tokens[$i];
        if (!is_array($token) || $token[0] !== T_STRING || strcasecmp($token[1], 'define') !== 0) {
            continue;
        }

        $args = [];
        $j    = $i + 1;
        // "(" then two arguments then ")", skipping whitespace and comments.
        if (($tokens[$j] ?? null) !== '(') {
            // token_get_all() may hand back whitespace between the two.
            while (isset($tokens[$j]) && is_array($tokens[$j])
                && in_array($tokens[$j][0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                $j++;
            }
            if (($tokens[$j] ?? null) !== '(') {
                continue;
            }
        }
        $j++;

        while (isset($tokens[$j]) && $tokens[$j] !== ')' && count($args) < 3) {
            $inner = $tokens[$j];
            if (is_array($inner)
                && in_array($inner[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) {
                $j++;
                continue;
            }
            if ($inner === ',') {
                $j++;
                continue;
            }
            $args[] = $inner;
            $j++;
        }

        if (count($args) !== 2 || !is_array($args[0]) || $args[0][0] !== T_CONSTANT_ENCAPSED_STRING) {
            continue;
        }

        $name = trax_config_local_literal($args[0])['value'] ?? null;
        if (!is_string($name) || !in_array($name, TRAX_CONFIG_LOCAL_KEYS, true)) {
            continue;
        }

        $value = trax_config_local_literal($args[1]);
        if ($value !== null) {
            $values[$name] = $value['value'];
        }
    }

    return $values;
}

/**
 * Decodes one PHP scalar literal token.
 *
 * Wrapped in ['value' => …] so that null — "this token is not a literal I
 * recognise" — stays distinguishable from a literal `false` or a literal `null`.
 *
 * @param array|string $token
 * @return array{value: string|bool|int|float|null}|null
 */
function trax_config_local_literal(array|string $token): ?array
{
    if (!is_array($token)) {
        return null;
    }

    if ($token[0] === T_CONSTANT_ENCAPSED_STRING) {
        $raw   = $token[1];
        $quote = $raw[0] ?? "'";
        $body  = substr($raw, 1, -1);

        // var_export() writes single quotes, where only \' and \\ mean
        // anything. A hand-edited double-quoted string gets the fuller set.
        return ['value' => $quote === "'"
            ? str_replace(['\\\\', "\\'"], ['\\', "'"], $body)
            : stripcslashes($body)];
    }

    if ($token[0] === T_LNUMBER) {
        return ['value' => (int)$token[1]];
    }
    if ($token[0] === T_DNUMBER) {
        return ['value' => (float)$token[1]];
    }
    if ($token[0] === T_STRING) {
        return match (strtolower($token[1])) {
            'true'  => ['value' => true],
            'false' => ['value' => false],
            'null'  => ['value' => null],
            default => null,
        };
    }

    return null;
}

/**
 * Merges $values into lib/config.local.php and rewrites it.
 *
 * Keys outside the whitelist are ignored. Keys already in the file and not
 * named here are kept — that is the whole point of reading it back first.
 *
 * @param array<string, mixed> $values
 * @throws RuntimeException if the file cannot be written
 */
function trax_config_local_write(array $values): void
{
    $merged = trax_config_local_read();

    foreach (TRAX_CONFIG_LOCAL_KEYS as $key) {
        if (!array_key_exists($key, $values)) {
            continue;
        }
        $value = $values[$key];
        if (!is_scalar($value) && $value !== null) {
            throw new RuntimeException("Cannot write {$key}: only scalar values belong in config.local.php.");
        }
        $merged[$key] = $value;
    }

    $lines = [
        '<?php',
        '/**',
        ' * Deployment settings for this installation.',
        ' *',
        ' * Generated on ' . date('Y-m-d H:i') . '. Safe to edit — but note that the',
        ' * installer and Settings → Authentication rewrite this file, keeping only',
        ' * the define() lines below.',
        ' *',
        ' * lib/config.php reads this file before it defines its own defaults, so',
        ' * every constant named here wins. Delete a line to fall back to the',
        ' * default; delete the file (and users.json) to run the installer again.',
        ' *',
        ' * Locked out because the external auth include no longer works? Delete the',
        ' * TRAX_AUTH_MODE line and the built-in login at login.php comes back.',
        ' */',
        '',
        'declare(strict_types=1);',
        '',
    ];

    foreach (TRAX_CONFIG_LOCAL_KEYS as $key) {
        if (array_key_exists($key, $merged)) {
            $lines[] = "define('" . $key . "', " . var_export($merged[$key], true) . ');';
        }
    }

    trax_config_local_put(trax_config_local_file(), implode("\n", $lines) . "\n");
}

/**
 * tempnam + rename, so nothing ever reads a half-written config.
 *
 * Written out here rather than reached for: lib/store.php has the same dance in
 * trax_write_atomic(), but this module is loaded by api.php AND by the
 * installer, and the installer has no other reason to pull the store in.
 */
function trax_config_local_put(string $path, string $contents): void
{
    $dir = dirname($path);
    $tmp = tempnam($dir, '.traxconf');
    if ($tmp === false) {
        throw new RuntimeException("Cannot create a temporary file in {$dir}.");
    }

    try {
        $written = file_put_contents($tmp, $contents);
        if ($written !== strlen($contents)) {
            throw new RuntimeException("Short write to {$tmp}.");
        }
        @chmod($tmp, 0644);
        if (!rename($tmp, $path)) {
            throw new RuntimeException("Cannot commit {$path}.");
        }
    } catch (Throwable $e) {
        @unlink($tmp);
        throw $e;
    }
}
