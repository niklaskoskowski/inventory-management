<?php
/**
 * TRAX Wide Label PNG endpoint
 *
 * Physical format:
 * 30 x 14 mm
 *
 * Render scale:
 * 1x = 354 x 165 px  (~300 DPI)
 * 3x = 1062 x 495 px (~900 DPI)
 *
 * The physical layout stays identical.
 */

@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
error_reporting(E_ALL);

ob_start();


/*
|--------------------------------------------------------------------------
| MODE
|--------------------------------------------------------------------------
*/

$mode = 'prod'; // prod | dev | test

$testLogoFallback = true;

$testId    = 123;
$testName  = 'MacBook Pro 16" 2021';
$testNotes = '123 W / 123 ø, M1 Max 123 äöüß';

$testLogo = __DIR__ . '/logo.png';

$isTestMode = in_array(
    $mode,
    ['dev', 'test'],
    true
);


/*
|--------------------------------------------------------------------------
| RENDER SCALE DEFAULT
|--------------------------------------------------------------------------
|
| 1 = ~300 DPI
| 3 = ~900 DPI
|
| Production can override this through:
|
|     label.renderScale
|
*/

$defaultRenderScale = 3;

/*
 * Initial value.
 * Gets replaced by the setting after TRAX has loaded.
 */
$renderScale = $defaultRenderScale;


/*
|--------------------------------------------------------------------------
| Pixel scaling helpers
|--------------------------------------------------------------------------
*/

/**
 * Scale a base 300-DPI pixel value.
 */
function wp(float $value): int
{
    global $renderScale;

    return (int)round(
        $value * $renderScale
    );
}


/**
 * Scale font sizes while retaining decimals.
 */
function wf(float $value): float
{
    global $renderScale;

    return $value * $renderScale;
}


/*
|--------------------------------------------------------------------------
| Error image
|--------------------------------------------------------------------------
*/

function wide_label_error_png(Throwable $e): void
{
    global $isTestMode;

    error_log(
        '[TRAX WIDE LABEL] ' .
        get_class($e) .
        ': ' .
        $e->getMessage() .
        ' in ' .
        $e->getFile() .
        ':' .
        $e->getLine()
    );

    if (!$isTestMode) {

        if (ob_get_length() !== false) {
            ob_end_clean();
        }

        http_response_code(500);

        return;
    }

    if (!function_exists('imagecreatetruecolor')) {

        if (ob_get_length() !== false) {
            ob_end_clean();
        }

        http_response_code(500);

        header(
            'Content-Type: text/plain; charset=UTF-8'
        );

        echo $e->getMessage();

        return;
    }

    $image = imagecreatetruecolor(
        700,
        220
    );

    $white = imagecolorallocate(
        $image,
        255,
        255,
        255
    );

    $black = imagecolorallocate(
        $image,
        0,
        0,
        0
    );

    imagefilledrectangle(
        $image,
        0,
        0,
        699,
        219,
        $white
    );

    $lines = [
        'TRAX WIDE LABEL ERROR',
        '',
        get_class($e),
        $e->getMessage(),
        '',
        basename($e->getFile()) . ':' . $e->getLine()
    ];

    $y = 15;

    foreach ($lines as $line) {

        $parts = str_split(
            $line,
            90
        );

        if (!$parts) {
            $parts = [''];
        }

        foreach ($parts as $part) {

            imagestring(
                $image,
                3,
                10,
                $y,
                $part,
                $black
            );

            $y += 18;
        }
    }

    if (ob_get_length() !== false) {
        ob_end_clean();
    }

    http_response_code(200);

    header(
        'Content-Type: image/png'
    );

    header(
        'Cache-Control: no-cache, no-store, must-revalidate'
    );

    imagepng(
        $image
    );

    @imagedestroy(
        $image
    );
}


/*
|--------------------------------------------------------------------------
| Setting helper
|--------------------------------------------------------------------------
*/

function wide_label_setting(
    string $key,
    mixed $default = null
): mixed {

    if (
        function_exists(
            'trax_setting'
        )
    ) {

        return trax_setting(
            $key,
            $default
        );
    }

    return $default;
}


/*
|--------------------------------------------------------------------------
| Font helper
|--------------------------------------------------------------------------
*/

function wide_label_font(
    string $type = 'bold'
) {

    if (
        function_exists(
            'trax_label_font'
        )
    ) {

        if (
            $type === 'heavy' &&
            defined('TRAX_FONT_HEAVY')
        ) {

            return trax_label_font(
                TRAX_FONT_HEAVY
            );
        }

        if (
            defined('TRAX_FONT_BOLD')
        ) {

            return trax_label_font(
                TRAX_FONT_BOLD
            );
        }
    }


    if ($type === 'heavy') {

        $heavyFont =
            __DIR__ .
            '/Arial_Black.ttf';

        if (
            is_file(
                $heavyFont
            )
        ) {

            return $heavyFont;
        }
    }


    $boldFont =
        __DIR__ .
        '/Arial_Bold.ttf';


    if (
        is_file(
            $boldFont
        )
    ) {

        return $boldFont;
    }


    return null;
}


/*
|--------------------------------------------------------------------------
| Text width helper
|--------------------------------------------------------------------------
*/

function wide_label_text_width(
    $font,
    float $fontSize,
    string $text
): int {

    if (
        function_exists(
            'trax_label_text_width'
        )
    ) {

        return (int)trax_label_text_width(
            $font,
            $fontSize,
            $text
        );
    }


    if (
        is_string($font) &&
        is_file($font) &&
        function_exists('imagettfbbox')
    ) {

        $box = imagettfbbox(
            $fontSize,
            0,
            $font,
            $text
        );


        if ($box !== false) {

            return (int)(
                $box[2] -
                $box[0]
            );
        }
    }


    /*
     * Approximate fallback.
     */
    return (int)(
        strlen($text) *
        max(
            7,
            $fontSize * 0.45
        )
    );
}


/*
|--------------------------------------------------------------------------
| Text output helper
|--------------------------------------------------------------------------
*/

function wide_label_text(
    $image,
    $font,
    float $fontSize,
    int $x,
    int $y,
    int $color,
    string $text
): void {

    if (
        function_exists(
            'trax_label_text'
        )
    ) {

        trax_label_text(
            $image,
            $font,
            $fontSize,
            $x,
            $y,
            $color,
            $text
        );

        return;
    }


    if (
        is_string($font) &&
        is_file($font) &&
        function_exists('imagettftext')
    ) {

        imagettftext(
            $image,
            $fontSize,
            0,
            $x,
            $y,
            $color,
            $font,
            $text
        );

        return;
    }


    imagestring(
        $image,
        5,
        $x,
        max(
            0,
            $y - wp(15)
        ),
        $text,
        $color
    );
}


/*
|--------------------------------------------------------------------------
| Vertical centering helper
|--------------------------------------------------------------------------
*/

function wide_label_vertical_center_baseline(
    $font,
    float $fontSize,
    string $text,
    int $top,
    int $bottom
): int {

    $areaCenter =
        (
            $top +
            $bottom
        ) / 2;


    if (
        is_string($font) &&
        is_file($font) &&
        function_exists('imagettfbbox')
    ) {

        $bbox = imagettfbbox(
            $fontSize,
            0,
            $font,
            $text
        );


        if ($bbox !== false) {

            $yValues = [
                $bbox[1],
                $bbox[3],
                $bbox[5],
                $bbox[7]
            ];


            $glyphTop =
                min(
                    $yValues
                );


            $glyphBottom =
                max(
                    $yValues
                );


            return (int)round(
                $areaCenter -
                (
                    (
                        $glyphTop +
                        $glyphBottom
                    ) / 2
                )
            );
        }
    }


    return (int)round(
        $areaCenter +
        wp(7)
    );
}


/*
|--------------------------------------------------------------------------
| Word wrap
|--------------------------------------------------------------------------
*/

function wide_label_wrap_text(
    string $text,
    $font,
    float $fontSize,
    int $maxWidth
): array {

    $words = preg_split(
        '/\s+/u',
        trim($text)
    );


    if (
        !is_array(
            $words
        )
    ) {

        return [$text];
    }


    $lines = [];
    $current = '';


    foreach ($words as $word) {

        if ($word === '') {
            continue;
        }


        $test = trim(
            $current .
            ' ' .
            $word
        );


        $testWidth =
            wide_label_text_width(
                $font,
                $fontSize,
                $test
            );


        if (
            $testWidth <=
            $maxWidth
        ) {

            $current =
                $test;

            continue;
        }


        if (
            $current !== ''
        ) {

            $lines[] =
                $current;

            $current =
                '';
        }


        /*
         * Word fits by itself.
         */

        if (
            wide_label_text_width(
                $font,
                $fontSize,
                $word
            ) <= $maxWidth
        ) {

            $current =
                $word;

            continue;
        }


        /*
         * Split exceptionally long words.
         */

        while ($word !== '') {

            $length =
                function_exists(
                    'mb_strlen'
                )
                    ? mb_strlen(
                        $word,
                        'UTF-8'
                    )
                    : strlen(
                        $word
                    );


            $found =
                false;


            for (
                $i = $length;
                $i > 0;
                $i--
            ) {

                $part =
                    function_exists(
                        'mb_substr'
                    )
                        ? mb_substr(
                            $word,
                            0,
                            $i,
                            'UTF-8'
                        )
                        : substr(
                            $word,
                            0,
                            $i
                        );


                if (
                    wide_label_text_width(
                        $font,
                        $fontSize,
                        $part
                    ) <= $maxWidth
                ) {

                    if (
                        $i ===
                        $length
                    ) {

                        $current =
                            $part;

                        $word =
                            '';

                    } else {

                        $lines[] =
                            $part;


                        $word =
                            function_exists(
                                'mb_substr'
                            )
                                ? mb_substr(
                                    $word,
                                    $i,
                                    null,
                                    'UTF-8'
                                )
                                : substr(
                                    $word,
                                    $i
                                );
                    }


                    $found =
                        true;

                    break;
                }
            }


            if (!$found) {

                $current =
                    $word;

                $word =
                    '';

                break;
            }
        }
    }


    if (
        $current !== ''
    ) {

        $lines[] =
            $current;
    }


    return $lines;
}


/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

try {

    /*
    |--------------------------------------------------------------------------
    | QR library
    |--------------------------------------------------------------------------
    */

    $qrLibrary =
        __DIR__ .
        '/phpqrcode/qrlib.php';


    if (
        !is_file(
            $qrLibrary
        )
    ) {

        throw new RuntimeException(
            'phpqrcode/qrlib.php not found.'
        );
    }


    require_once $qrLibrary;


    /*
    |--------------------------------------------------------------------------
    | TRAX environment
    |--------------------------------------------------------------------------
    */

    $configFile =
        __DIR__ .
        '/lib/config.php';


    $storeFile =
        __DIR__ .
        '/lib/store.php';


    $traxAvailable =
        is_file(
            $configFile
        ) &&
        is_file(
            $storeFile
        );


    if (
        !$traxAvailable &&
        !$isTestMode
    ) {

        throw new RuntimeException(
            'TRAX config.php/store.php not found.'
        );
    }


    if ($traxAvailable) {

        require_once $configFile;

        require_once $storeFile;
    }


    /*
    |--------------------------------------------------------------------------
    | RENDER SCALE SETTING
    |--------------------------------------------------------------------------
    |
    | Setting:
    |
    |     label.renderScale
    |
    | Allowed:
    |
    |     1
    |     3
    |
    */

    $configuredRenderScale =
        (int)wide_label_setting(
            'label.renderScale',
            $defaultRenderScale
        );


    /*
     * Convenient testing:
     *
     *     label-wide.php?scale=3
     *
     * Only allowed in dev/test.
     */

    if (
        $isTestMode &&
        isset($_GET['scale'])
    ) {

        $configuredRenderScale =
            (int)$_GET['scale'];
    }


    /*
     * Only permit the supported resolutions.
     */

    if (
        !in_array(
            $configuredRenderScale,
            [1, 3],
            true
        )
    ) {

        $configuredRenderScale =
            1;
    }


    $renderScale =
        $configuredRenderScale;


    /*
    |--------------------------------------------------------------------------
    | INPUTS
    |--------------------------------------------------------------------------
    */

    $id =
        isset(
            $_GET['id']
        )
            ? (int)$_GET['id']
            : 0;


    /*
     * ?u= names one physical unit of the asset ("12.1"). It is honoured only
     * once the unit is found on the record below; an unknown one falls back to
     * the product label rather than printing a code that resolves to nothing.
     */

    $inputUnit = filter_input(
        INPUT_GET,
        'u',
        FILTER_VALIDATE_INT
    );


    $unitNo = (
        $inputUnit !== false &&
        $inputUnit !== null &&
        $inputUnit > 0
    )
        ? (int)$inputUnit
        : null;


    $unitLabel =
        '';


    $unitFound =
        false;


    $name =
        '';


    $notes =
        '';


    /*
    |--------------------------------------------------------------------------
    | LOAD FROM TRAX STORE
    |--------------------------------------------------------------------------
    */

    if (
        $traxAvailable &&
        function_exists(
            'trax_read_data'
        ) &&
        function_exists(
            'trax_find_asset'
        )
    ) {

        $labelData =
            trax_read_data();


        if (
            is_array(
                $labelData
            ) &&
            isset(
                $labelData['assets']
            ) &&
            is_array(
                $labelData['assets']
            )
        ) {

            $labelAsset =
                trax_find_asset(
                    $labelData['assets'],
                    $id
                );


            if (
                is_array(
                    $labelAsset
                )
            ) {

                $name =
                    (string)(
                        $labelAsset['name']
                        ?? ''
                    );


                $notes =
                    (string)(
                        $labelAsset['notes']
                        ?? ''
                    );


                if (
                    $unitNo !== null &&
                    function_exists(
                        'trax_asset_has_units'
                    ) &&
                    trax_asset_has_units(
                        $labelAsset
                    )
                ) {

                    foreach (
                        $labelAsset['units']
                        as $unitRow
                    ) {

                        if (
                            (int)$unitRow['no']
                            !== $unitNo
                        ) {

                            continue;
                        }


                        $unitFound =
                            true;


                        $unitLabel =
                            (string)(
                                $unitRow['label']
                                ?? ''
                            );


                        break;
                    }
                }
            }
        }
    }


    /*
     * No matching unit on a real record means no unit label: fall back to the
     * product label rather than print a code that resolves to nothing.
     */

    if (!$unitFound) {

        $unitNo =
            null;

        $unitLabel =
            '';
    }


    /*
    |--------------------------------------------------------------------------
    | DEV / TEST DATA
    |--------------------------------------------------------------------------
    */

    if ($isTestMode) {

        if (
            $id <= 0
        ) {

            $id =
                $testId;
        }


        if (
            !empty(
                $_GET['name']
            )
        ) {

            $name =
                function_exists(
                    'mb_substr'
                )
                    ? mb_substr(
                        (string)$_GET['name'],
                        0,
                        200,
                        'UTF-8'
                    )
                    : substr(
                        (string)$_GET['name'],
                        0,
                        200
                    );
        }


        if (
            !empty(
                $_GET['notes']
            )
        ) {

            $notes =
                function_exists(
                    'mb_substr'
                )
                    ? mb_substr(
                        (string)$_GET['notes'],
                        0,
                        300,
                        'UTF-8'
                    )
                    : substr(
                        (string)$_GET['notes'],
                        0,
                        300
                    );
        }


        if (
            $name === ''
        ) {

            $name =
                $testName;
        }


        if (
            $notes === ''
        ) {

            $notes =
                $testNotes;
        }
    }


    if (
        $name === ''
    ) {

        $name =
            'Unknown';
    }


    /*
     * The unit's own label needs a home. The notes strip under the separator is
     * the roomiest one, so it goes there when nothing else claims it; otherwise
     * it rides along after the name, as on the portrait label.
     */

    if (
        $unitLabel !== ''
    ) {

        if (
            $notes === ''
        ) {

            $notes =
                $unitLabel;

        } else {

            $name =
                $name .
                ' – ' .
                $unitLabel;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | QR DATA
    |--------------------------------------------------------------------------
    */

    if (
        function_exists(
            'trax_label_url'
        )
    ) {

        $qrLink =
            trax_label_url(
                $id,
                $unitNo
            );

    } else {

        $scheme =
            (
                !empty(
                    $_SERVER['HTTPS']
                ) &&
                $_SERVER['HTTPS']
                !== 'off'
            )
                ? 'https'
                : 'http';


        $host =
            $_SERVER['HTTP_HOST']
            ?? 'localhost';


        $qrLink =
            $scheme .
            '://' .
            $host .
            '/?id=' .
            urlencode(
                (string)$id
            ) .
            (
                $unitNo !== null
                    ? '&u=' . urlencode(
                        (string)$unitNo
                    )
                    : ''
            );
    }


    /*
    |--------------------------------------------------------------------------
    | DIMENSIONS
    |--------------------------------------------------------------------------
    |
    | Base:
    |
    | 1x:
    | 354 x 165
    |
    | 3x:
    | 1062 x 495
    |
    */

    $width =
        wp(354);


    $height =
        wp(165);


    /*
    |--------------------------------------------------------------------------
    | IMAGE + COLORS
    |--------------------------------------------------------------------------
    */

    $image =
        imagecreatetruecolor(
            $width,
            $height
        );


    if (
        $image === false
    ) {

        throw new RuntimeException(
            'GD could not create label canvas.'
        );
    }


    /*
     * Store intended output resolution where supported.
     */

    if (
        function_exists(
            'imageresolution'
        )
    ) {

        @imageresolution(
            $image,
            300 * $renderScale,
            300 * $renderScale
        );
    }


    $white =
        imagecolorallocate(
            $image,
            255,
            255,
            255
        );


    $black =
        imagecolorallocate(
            $image,
            0,
            0,
            0
        );


    $gray =
        imagecolorallocate(
            $image,
            0,
            0,
            0
        );


    imagefilledrectangle(
        $image,
        0,
        0,
        $width,
        $height,
        $white
    );


    /*
    |--------------------------------------------------------------------------
    | FONT
    |--------------------------------------------------------------------------
    */

    $font =
        wide_label_font(
            'bold'
        );


    /*
    |--------------------------------------------------------------------------
    | LOGO
    |--------------------------------------------------------------------------
    */

    $marginLeft =
        wp(12);


    $logo =
        null;


    /*
     * Used for vertical centering of one-line names.
     */

    $brandingBottomY =
        wp(40);


    $configuredLogo =
        (string)wide_label_setting(
            'branding.logoFile',
            ''
        );


    /*
     * Production/configured logo first.
     */

    if (
        $configuredLogo !== '' &&
        function_exists(
            'trax_label_logo_image'
        )
    ) {

        $candidate =
            trax_label_logo_image(
                $configuredLogo
            );


        if (
            $candidate !== null &&
            $candidate !== false
        ) {

            $logo =
                $candidate;
        }
    }


    /*
     * Local dev/test fallback.
     */

    if (
        $logo === null &&
        $isTestMode &&
        $testLogoFallback &&
        is_file(
            $testLogo
        )
    ) {

        $candidate =
            @imagecreatefrompng(
                $testLogo
            );


        if (
            $candidate !== false
        ) {

            $logo =
                $candidate;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | Render logo
    |--------------------------------------------------------------------------
    */

    if (
        $logo !== null
    ) {

        $srcLogoWidth =
            imagesx(
                $logo
            );


        $srcLogoHeight =
            imagesy(
                $logo
            );


        if (
            $srcLogoWidth > 0 &&
            $srcLogoHeight > 0
        ) {

            /*
             * KEEPING YOUR CURRENT WIDTH.
             */

            $maxLogoWidth =
                wp(165);


            /*
             * KEEPING YOUR CURRENT MAXIMUM:
             *
             * 3.0 mm.
             *
             * This scales automatically with output resolution.
             */

            $outputDpi =
                300 *
                $renderScale;


            $maxLogoHeight =
                (int)round(
                    (
                        3.0 /
                        25.4
                    ) *
                    $outputDpi
                );


            $scaleByWidth =
                $maxLogoWidth /
                $srcLogoWidth;


            $scaleByHeight =
                $maxLogoHeight /
                $srcLogoHeight;


            $logoScale =
                min(
                    $scaleByWidth,
                    $scaleByHeight
                );


            $logoW =
                max(
                    1,
                    (int)round(
                        $srcLogoWidth *
                        $logoScale
                    )
                );


            $logoH =
                max(
                    1,
                    (int)round(
                        $srcLogoHeight *
                        $logoScale
                    )
                );


            $logoX =
                $marginLeft;


            $logoY =
                wp(15);


            imagecopyresampled(
                $image,
                $logo,

                $logoX,
                $logoY,

                0,
                0,

                $logoW,
                $logoH,

                $srcLogoWidth,
                $srcLogoHeight
            );


            $brandingBottomY =
                $logoY +
                $logoH;
        }


        @imagedestroy(
            $logo
        );

    } else {

        /*
        |--------------------------------------------------------------------------
        | No logo: organisation name
        |--------------------------------------------------------------------------
        */

        $labelOrg =
            (string)wide_label_setting(
                'branding.orgName',
                ''
            );


        if (
            $labelOrg === ''
        ) {

            $labelOrg =
                (string)wide_label_setting(
                    'branding.appName',
                    'Assets'
                );
        }


        $orgSize =
            wf(19.0);


        $orgMinSize =
            wf(9.0);


        $orgStep =
            wf(1.0);


        while (
            $orgSize > $orgMinSize &&
            wide_label_text_width(
                $font,
                $orgSize,
                $labelOrg
            ) > wp(165)
        ) {

            $orgSize -=
                $orgStep;
        }


        wide_label_text(
            $image,
            $font,
            $orgSize,
            $marginLeft,
            wp(40),
            $black,
            $labelOrg
        );


        $brandingBottomY =
            wp(43);
    }


    /*
    |--------------------------------------------------------------------------
    | QR CODE
    |--------------------------------------------------------------------------
    */

    $qrTemp =
        tempnam(
            sys_get_temp_dir(),
            'qr_'
        );


    if (
        $qrTemp === false
    ) {

        throw new RuntimeException(
            'Could not create QR temporary file.'
        );
    }


    /*
     * Generate QR itself at higher source resolution too.
     */

    $qrModuleSize =
        2 *
        $renderScale;


    QRcode::png(
        $qrLink,
        $qrTemp,
        QR_ECLEVEL_L,
        $qrModuleSize,
        1
    );


    $qrImg =
        @imagecreatefrompng(
            $qrTemp
        );


    if (
        $qrImg === false
    ) {

        @unlink(
            $qrTemp
        );


        throw new RuntimeException(
            'Generated QR code could not be read as PNG.'
        );
    }


    $qrSize =
        wp(105);


    $qrX =
        $width -
        $qrSize -
        wp(15);


    $qrY =
        wp(12);


    imagecopyresampled(
        $image,
        $qrImg,

        $qrX,
        $qrY,

        0,
        0,

        $qrSize,
        $qrSize,

        imagesx(
            $qrImg
        ),

        imagesy(
            $qrImg
        )
    );


    @imagedestroy(
        $qrImg
    );


    @unlink(
        $qrTemp
    );


    /*
    |--------------------------------------------------------------------------
    | TEXT SETTINGS
    |--------------------------------------------------------------------------
    |
    | KEEPING YOUR CURRENT WIDTH:
    |
    | 202 px @ 1x
    | 606 px @ 3x
    |
    */

    $maxTextWidth =
        wp(202);


    /*
    |--------------------------------------------------------------------------
    | SEPARATOR GEOMETRY
    |--------------------------------------------------------------------------
    */

    $lineStartX =
        $marginLeft;


    $lineEndX =
        $qrX -
        wp(15);


    $fixedLineY =
        wp(111);


    /*
    |--------------------------------------------------------------------------
    | NAME
    |--------------------------------------------------------------------------
    */

    $fontSizeName =
        wf(21);


    $lineHeightName =
        wp(27);


    $nameY =
        wp(75);


    $nameLines =
        wide_label_wrap_text(
            $name,
            $font,
            $fontSizeName,
            $maxTextWidth
        );


    /*
     * Exactly one line:
     *
     * vertically center between actual branding/logo bottom
     * and separator.
     *
     * Horizontal alignment stays LEFT.
     */

    if (
        count(
            $nameLines
        ) === 1
    ) {

        $singleLine =
            $nameLines[0];


        $nameAreaTop =
            $brandingBottomY +
            wp(3);


        $nameAreaBottom =
            $fixedLineY -
            wp(3);


        $centeredNameY =
            wide_label_vertical_center_baseline(
                $font,
                $fontSizeName,
                $singleLine,
                $nameAreaTop,
                $nameAreaBottom
            );


        wide_label_text(
            $image,
            $font,
            $fontSizeName,
            $marginLeft,
            $centeredNameY,
            $black,
            $singleLine
        );

    } else {

        /*
         * Multiple lines:
         * keep existing behaviour.
         */

        $y =
            $nameY;


        foreach (
            $nameLines
            as $line
        ) {

            if (
                $y >= wp(108)
            ) {

                break;
            }


            wide_label_text(
                $image,
                $font,
                $fontSizeName,
                $marginLeft,
                $y,
                $black,
                $line
            );


            $y +=
                $lineHeightName;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | FIXED SEPARATOR
    |--------------------------------------------------------------------------
    */

    imagesetthickness(
        $image,
        max(
            1,
            wp(3)
        )
    );


    imageline(
        $image,
        $lineStartX,
        $fixedLineY,
        $lineEndX,
        $fixedLineY,
        $gray
    );


    /*
    |--------------------------------------------------------------------------
    | NOTES
    |--------------------------------------------------------------------------
    */

    if (
        $notes !== ''
    ) {

        $notes =
            str_replace(
                [
                    "\r\n",
                    "\r",
                    "\n"
                ],
                ' ',
                $notes
            );


        $fontSizeNotes =
            wf(14.7);


        $lineHeightNotes =
            wf(17.7);


        $notesY =
            wp(133);


        $noteLines =
            wide_label_wrap_text(
                $notes,
                $font,
                $fontSizeNotes,
                $maxTextWidth
            );


        $y =
            $notesY;


        foreach (
            $noteLines
            as $line
        ) {

            if (
                $y > wp(160)
            ) {

                break;
            }


            wide_label_text(
                $image,
                $font,
                $fontSizeNotes,
                $marginLeft,
                (int)round($y),
                $black,
                $line
            );


            $y +=
                $lineHeightNotes;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | ID BAR UNDER QR
    |--------------------------------------------------------------------------
    */

    $barHeight =
        wp(30);


    $barY =
        $qrY +
        $qrSize +
        wp(3);


    imagefilledrectangle(
        $image,

        $qrX + wp(3),
        $barY,

        $qrX +
        $qrSize -
        wp(3),

        $barY +
        $barHeight,

        $black
    );


    /*
    |--------------------------------------------------------------------------
    | ID TEXT
    |--------------------------------------------------------------------------
    */

    $idText =
        'ID ' .
        (
            $unitNo !== null &&
            function_exists(
                'trax_unit_code'
            )
                ? trax_unit_code(
                    $id,
                    $unitNo
                )
                : (string)$id
        );


    $fontSizeId =
        wf(20);


    $idFont =
        wide_label_font(
            'bold'
        );


    $textWidth =
        wide_label_text_width(
            $idFont,
            $fontSizeId,
            $idText
        );


    /*
     * The bar is only as wide as the QR, and "ID 1234" already fills it edge to
     * edge — a unit code ("ID 1234.12") ran off both ends and printed white on
     * white. Shrink until it fits rather than lose characters.
     */

    $idMaxWidth =
        $qrSize -
        wp(10);


    while (
        $textWidth > $idMaxWidth &&
        $fontSizeId > wf(9)
    ) {

        $fontSizeId -=
            wf(0.5);


        $textWidth =
            wide_label_text_width(
                $idFont,
                $fontSizeId,
                $idText
            );
    }


    $textX =
        (int)round(
            $qrX +
            (
                $qrSize -
                $textWidth
            ) /
            2
        );


    $textY =
        $barY +
        $barHeight -
        wp(5);


    wide_label_text(
        $image,
        $idFont,
        $fontSizeId,
        $textX,
        $textY,
        $white,
        $idText
    );


    /*
    |--------------------------------------------------------------------------
    | OUTPUT
    |--------------------------------------------------------------------------
    */

    if (
        ob_get_length()
        !== false
    ) {

        ob_end_clean();
    }


    http_response_code(
        200
    );


    header(
        'Content-Type: image/png'
    );


    header(
        'Cache-Control: no-cache, no-store, must-revalidate'
    );


    /*
     * Handy for checking what the server produced.
     */

    header(
        'X-TRAX-Render-Scale: ' .
        $renderScale
    );


    imagepng(
        $image
    );


    @imagedestroy(
        $image
    );


} catch (Throwable $e) {

    wide_label_error_png(
        $e
    );
}

?>