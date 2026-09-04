# Fonts

`label.php` and `label-w.php` draw printed labels with GD's `imagettftext()`,
which needs a TrueType file on disk — shared hosts have no fontconfig, so the
face cannot be looked up by name and is shipped here instead.

## What is here

| File | Role |
| --- | --- |
| `LiberationSans-Bold.ttf` | `TRAX_FONT_BOLD` and `TRAX_FONT_HEAVY` (lib/config.php) |
| `LiberationSans-Regular.ttf` | not referenced yet; kept so a deployment can point `TRAX_FONT_BOLD` at a lighter face |
| `LICENSE` | the SIL Open Font License these are distributed under |

Liberation Sans 2.1.5, from the upstream release:
<https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz>

    LiberationSans-Bold.ttf     sha256 788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173
    LiberationSans-Regular.ttf  sha256 76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8

## Replacing them

Point `TRAX_FONT_BOLD` / `TRAX_FONT_HEAVY` at any `.ttf` in this directory from
`lib/config.local.php`. Nothing else has to change.

If the file a constant names is missing, labels still render: both endpoints
fall back to GD's built-in bitmap font rather than failing. The result is ugly
and ASCII-only, so it is a fallback, not a supported configuration.
