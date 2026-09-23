<?php
/**
 * A small, safe Markdown renderer — for the terms & conditions and nothing else.
 *
 * The ONE renderer: terms.php and booking.php call it directly, and the
 * Settings preview asks api.php (terms.preview) for its output rather than
 * carrying a JavaScript twin that would drift from what customers are shown.
 *
 * Safe by construction: every piece of text is escaped before any tag is put
 * around it, and raw HTML in the source is shown as text, never passed
 * through. Links keep only http(s), mailto, tel and scheme-less targets, so a
 * `javascript:` URL cannot survive into an href.
 *
 * The subset is what a legal text needs and no more:
 *
 *   # / ## / ###      headings (rendered one level down: the page owns <h1>)
 *   - item, 1. item   lists, one level
 *   > quote           a block quote
 *   ---               a horizontal rule
 *   **bold**, *italic*, `code`, [label](url), bare https:// links
 *
 * A single line break inside a paragraph is kept as a line break. That is not
 * CommonMark, and it is deliberate: terms are typed into a textarea by people
 * who expect the line they ended to stay ended.
 */

declare(strict_types=1);

/** Markdown in, HTML out. Empty in, empty out. */
function trax_markdown(string $text): string
{
    $lines = explode("\n", str_replace(["\r\n", "\r"], "\n", $text));
    return trax_markdown_blocks($lines);
}

/** Renders a run of lines as block elements. */
function trax_markdown_blocks(array $lines): string
{
    $out   = [];
    $para  = [];      // lines of the paragraph being collected
    $list  = null;    // ['tag' => 'ul'|'ol', 'start' => int, 'items' => [[lines]]]
    $quote = null;    // lines of the block quote being collected

    $flushPara = static function () use (&$para, &$out): void {
        if ($para !== []) {
            $out[] = '<p>' . implode("<br>\n", array_map('trax_markdown_inline', $para)) . '</p>';
            $para  = [];
        }
    };
    $flushList = static function () use (&$list, &$out): void {
        if ($list === null) {
            return;
        }
        $start = $list['tag'] === 'ol' && $list['start'] !== 1 ? ' start="' . $list['start'] . '"' : '';
        $html  = '<' . $list['tag'] . $start . '>';
        foreach ($list['items'] as $item) {
            $html .= '<li>' . implode("<br>\n", array_map('trax_markdown_inline', $item)) . '</li>';
        }
        $out[] = $html . '</' . $list['tag'] . '>';
        $list  = null;
    };
    $flushQuote = static function () use (&$quote, &$out): void {
        if ($quote !== null) {
            $out[] = '<blockquote>' . trax_markdown_blocks($quote) . '</blockquote>';
            $quote = null;
        }
    };
    $flushAll = static function () use ($flushPara, $flushList, $flushQuote): void {
        $flushPara();
        $flushList();
        $flushQuote();
    };

    foreach ($lines as $line) {
        $line = rtrim($line);

        if (trim($line) === '') {
            $flushAll();
            continue;
        }

        // A quote swallows its own lines; anything else ends it.
        if (preg_match('/^\s{0,3}>\s?(.*)$/', $line, $m)) {
            $flushPara();
            $flushList();
            $quote ??= [];
            $quote[] = $m[1];
            continue;
        }
        $flushQuote();

        if (preg_match('/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/', $line, $m)) {
            $flushAll();
            // One level down, and never past <h4>: the page's own title is
            // the <h1>, and six sizes of heading in a legal text is noise.
            $level = min(4, strlen($m[1]) + 1);
            $out[] = "<h{$level}>" . trax_markdown_inline($m[2]) . "</h{$level}>";
            continue;
        }

        if (preg_match('/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/', $line)) {
            $flushAll();
            $out[] = '<hr>';
            continue;
        }

        if (preg_match('/^\s{0,3}[-*+]\s+(.*)$/', $line, $m)) {
            $flushPara();
            if ($list === null || $list['tag'] !== 'ul') {
                $flushList();
                $list = ['tag' => 'ul', 'start' => 1, 'items' => []];
            }
            $list['items'][] = [$m[1]];
            continue;
        }

        if (preg_match('/^\s{0,3}(\d{1,9})[.)]\s+(.*)$/', $line, $m)) {
            $flushPara();
            if ($list === null || $list['tag'] !== 'ol') {
                $flushList();
                $list = ['tag' => 'ol', 'start' => (int)$m[1], 'items' => []];
            }
            $list['items'][] = [$m[2]];
            continue;
        }

        // An indented line under a list item continues that item.
        if ($list !== null && preg_match('/^\s{2,}(\S.*)$/', $line, $m)) {
            $list['items'][array_key_last($list['items'])][] = $m[1];
            continue;
        }

        $flushList();
        $para[] = trim($line);
    }
    $flushAll();

    return implode("\n", $out);
}

/**
 * Inline formatting for one line.
 *
 * Code spans and links are cut out first and parked behind placeholders, so
 * the emphasis rules below can never reach into a URL (underscores are common
 * there) or into code. The placeholder is built from \x01, which trax_str()
 * strips from anything stored, so it cannot be forged by the text itself.
 */
function trax_markdown_inline(string $text): string
{
    $parked = [];
    $park   = static function (string $html) use (&$parked): string {
        $parked[] = $html;
        return "\x01" . (count($parked) - 1) . "\x01";
    };
    $esc = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

    $text = preg_replace_callback('/`([^`]+)`/', static fn (array $m): string => $park('<code>' . $esc($m[1]) . '</code>'), $text) ?? '';

    $text = preg_replace_callback(
        '/\[([^\]\x01]+)\]\(\s*([^()\s]+)\s*\)/',
        static function (array $m) use ($park, $esc): string {
            $href = trax_markdown_href($m[2]);
            $label = trax_markdown_emphasis($esc($m[1]));
            if ($href === null) {
                return $park($label);
            }
            return $park('<a href="' . $esc($href) . '" target="_blank" rel="noopener noreferrer">' . $label . '</a>');
        },
        $text
    ) ?? '';

    $text = preg_replace_callback(
        '~\bhttps?://[^\s<>\x01]+[^\s<>\x01.,;:!?)\]\'"]~i',
        static fn (array $m): string => $park('<a href="' . $esc($m[0]) . '" target="_blank" rel="noopener noreferrer">' . $esc($m[0]) . '</a>'),
        $text
    ) ?? '';

    $html = trax_markdown_emphasis($esc($text));

    return preg_replace_callback('/\x01(\d+)\x01/', static fn (array $m): string => $parked[(int)$m[1]] ?? '', $html) ?? '';
}

/** **bold** / __bold__, then *italic* / _italic_, on already-escaped text. */
function trax_markdown_emphasis(string $html): string
{
    $html = preg_replace('/\*\*(?=\S)(.+?)(?<=\S)\*\*/u', '<strong>$1</strong>', $html) ?? $html;
    $html = preg_replace('/(?<![\w])__(?=\S)(.+?)(?<=\S)__(?![\w])/u', '<strong>$1</strong>', $html) ?? $html;
    $html = preg_replace('/(?<![\*\w])\*(?=\S)(.+?)(?<=\S)\*(?![\*\w])/u', '<em>$1</em>', $html) ?? $html;
    $html = preg_replace('/(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])/u', '<em>$1</em>', $html) ?? $html;
    return $html;
}

/** A link target that may go into an href, or null. */
function trax_markdown_href(string $raw): ?string
{
    $url = trim($raw);
    if ($url === '') {
        return null;
    }
    // A scheme is whatever comes before the first colon that precedes any
    // path, query or fragment character. None at all is a relative link.
    if (preg_match('/^([a-z][a-z0-9+.\-]*):/i', $url, $m)) {
        return in_array(strtolower($m[1]), ['http', 'https', 'mailto', 'tel'], true) ? $url : null;
    }
    // Scheme-less, but a colon before the first slash is what a browser
    // could still read as one ("javascript&colon;" arrives decoded here).
    $head = preg_split('~[/?#]~', $url, 2)[0] ?? '';
    return str_contains($head, ':') ? null : $url;
}
