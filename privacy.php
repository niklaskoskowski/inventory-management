<?php
/**
 * Public privacy notice.
 *
 *   GET privacy.php          the version in force
 *   GET privacy.php?v=<n>    one version by number
 *   GET privacy.php?lang=de  in German (or en)
 *
 * The same page as terms.php, for the second legal document: shown and
 * acknowledged in the same step as the terms when a hand-over is signed, and
 * versioned the same way so a signature can name what was shown.
 */

declare(strict_types=1);

$legalKind = 'privacy';
require __DIR__ . '/terms.php';
