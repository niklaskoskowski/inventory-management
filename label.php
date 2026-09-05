<?php
/**
 * TRAX Portrait Label PNG endpoint
 *
 * Physical format:
 * 14 x 30 mm
 *
 * Render scale:
 * 1x = 165 x 354 px  (~300 DPI)
 * 3x = 495 x 1062 px (~900 DPI)
 *
 * Production:
 * - Uses TRAX config/settings/store
 *
 * Dev/Test:
 * - Demo data fallback
 * - ./logo.png fallback
 *
 * Setting:
 * - label.renderScale = 1 or 3
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

$testId   = 123;
$testName = 'Testgerät';
$testLogo = __DIR__ . '/logo.png';

$isTestMode = in_array(
    $mode,
    ['dev', 'test'],
    true
);


/*
|--------------------------------------------------------------------------
| RENDER SCALE
|--------------------------------------------------------------------------
|
| 1 = ~300 DPI
| 3 = ~900 DPI
|
| Can be overridden through:
|
|     label.renderScale
|
*/

$defaultRenderScale = 3;
$renderScale = $defaultRenderScale;


/*
|--------------------------------------------------------------------------
| Scaling helpers
|--------------------------------------------------------------------------
*/

function label_px(float $value): int
{
    global $renderScale;

    return (int)round(
        $value * $renderScale
    );
}


function label_font_px(float $value): float
{
    global $renderScale;

    return $value * $renderScale;
}


/*
|--------------------------------------------------------------------------
| Error PNG helper
|--------------------------------------------------------------------------
*/

function label_error_png(Throwable $e): void
{
    global $isTestMode;

    error_log(
        '[TRAX LABEL] ' .
        get_class($e) .
        ': ' .
        $e->getMessage() .
        ' in ' .
        $e->getFile() .
        ':' .
        $e->getLine()
    );

    header(
        'X-Robots-Tag: noindex, nofollow'
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

    $width  = 700;
    $height = 260;

    $image = imagecreatetruecolor(
        $width,
        $height
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
        $width,
        $height,
        $white
    );

    $message =
        get_class($e) .
        ': ' .
        $e->getMessage();

    $file =
        basename($e->getFile()) .
        ':' .
        $e->getLine();

    $lines = [
        'TRAX LABEL ERROR',
        '',
        $message,
        '',
        $file
    ];

    $y = 20;

    foreach ($lines as $line) {

        $wrapped = str_split(
            $line,
            90
        );

        if ($wrapped === []) {
            $wrapped = [''];
        }

        foreach ($wrapped as $part) {

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

    if (!is_file($qrLibrary)) {

        throw new RuntimeException(
            'phpqrcode/qrlib.php not found.'
        );
    }

    require_once $qrLibrary;


    /*
    |--------------------------------------------------------------------------
    | TRAX includes
    |--------------------------------------------------------------------------
    */

    $configFile =
        __DIR__ .
        '/lib/config.php';

    $storeFile =
        __DIR__ .
        '/lib/store.php';

    $traxAvailable =
        is_file($configFile) &&
        is_file($storeFile);


    if (
        !$traxAvailable &&
        !$isTestMode
    ) {

        throw new RuntimeException(
            'TRAX config/store files not found.'
        );
    }


    if ($traxAvailable) {

        require_once $configFile;
        require_once $storeFile;
    }


    /*
    |--------------------------------------------------------------------------
    | Helper: setting
    |--------------------------------------------------------------------------
    */

    function label_setting(
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
    | Render scale setting
    |--------------------------------------------------------------------------
    */

    $configuredRenderScale =
        (int)label_setting(
            'label.renderScale',
            $defaultRenderScale
        );


    /*
     * In dev/test you can also use:
     *
     *     ?scale=3
     */

    if (
        $isTestMode &&
        isset($_GET['scale'])
    ) {

        $configuredRenderScale =
            (int)$_GET['scale'];
    }


    /*
     * Supported resolutions only.
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
    | Helper: text width
    |--------------------------------------------------------------------------
    */

    function label_text_width(
        $font,
        float $size,
        string $text
    ): int {

        if (
            function_exists(
                'trax_label_text_width'
            )
        ) {

            return (int)trax_label_text_width(
                $font,
                $size,
                $text
            );
        }


        if (
            is_string($font) &&
            is_file($font) &&
            function_exists(
                'imagettfbbox'
            )
        ) {

            $box = imagettfbbox(
                $size,
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


        return (int)(
            strlen($text) *
            max(
                7,
                $size * 0.45
            )
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Helper: render text
    |--------------------------------------------------------------------------
    */

    function label_text(
        $image,
        $font,
        float $size,
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
                $size,
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
            function_exists(
                'imagettftext'
            )
        ) {

            imagettftext(
                $image,
                $size,
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
                $y - label_px(15)
            ),
            $text,
            $color
        );
    }


    /*
    |--------------------------------------------------------------------------
    | Helper: font
    |--------------------------------------------------------------------------
    */

    function label_font(
        string $type
    ) {

        if (
            function_exists(
                'trax_label_font'
            )
        ) {

            if (
                $type === 'heavy' &&
                defined(
                    'TRAX_FONT_HEAVY'
                )
            ) {

                return trax_label_font(
                    TRAX_FONT_HEAVY
                );
            }


            if (
                defined(
                    'TRAX_FONT_BOLD'
                )
            ) {

                return trax_label_font(
                    TRAX_FONT_BOLD
                );
            }
        }


        /*
         * Local standalone fallbacks.
         */

        if ($type === 'heavy') {

            $file =
                __DIR__ .
                '/Arial_Black.ttf';

            if (is_file($file)) {
                return $file;
            }
        }


        $file =
            __DIR__ .
            '/Arial_Bold.ttf';

        if (is_file($file)) {
            return $file;
        }


        return null;
    }


    /*
    |--------------------------------------------------------------------------
    | Helper: wrap text
    |--------------------------------------------------------------------------
    */

    function label_wrap_text(
        string $text,
        $font,
        float $fontSize,
        int $maxWidth
    ): array {

        $words = preg_split(
            '/\s+/u',
            trim($text)
        );


        if (!is_array($words)) {

            return [$text];
        }


        $lines = [];
        $currentLine = '';


        foreach ($words as $word) {

            if ($word === '') {
                continue;
            }


            $testLine = trim(
                $currentLine .
                ' ' .
                $word
            );


            if (
                label_text_width(
                    $font,
                    $fontSize,
                    $testLine
                ) <= $maxWidth
            ) {

                $currentLine =
                    $testLine;

                continue;
            }


            if ($currentLine !== '') {

                $lines[] =
                    $currentLine;

                $currentLine =
                    '';
            }


            /*
             * Word fits by itself.
             */

            if (
                label_text_width(
                    $font,
                    $fontSize,
                    $word
                ) <= $maxWidth
            ) {

                $currentLine =
                    $word;

                continue;
            }


            /*
             * Split long words safely.
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
                        label_text_width(
                            $font,
                            $fontSize,
                            $part
                        ) <= $maxWidth
                    ) {

                        if (
                            $i ===
                            $length
                        ) {

                            $currentLine =
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

                    $currentLine =
                        $word;

                    $word =
                        '';

                    break;
                }
            }
        }


        if ($currentLine !== '') {

            $lines[] =
                $currentLine;
        }


        return $lines;
    }


    /*
    |--------------------------------------------------------------------------
    | Input / demo data
    |--------------------------------------------------------------------------
    */

    $inputId = filter_input(
        INPUT_GET,
        'id',
        FILTER_VALIDATE_INT
    );


    $id = (
        $inputId !== false &&
        $inputId !== null &&
        $inputId > 0
    )
        ? (int)$inputId
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


    $rawName =
        (string)(
            $_GET['name']
            ?? ''
        );


    if (
        function_exists(
            'trax_str'
        )
    ) {

        $name =
            trax_str(
                $rawName,
                200
            );

    } else {

        $name =
            function_exists(
                'mb_substr'
            )
                ? mb_substr(
                    $rawName,
                    0,
                    200,
                    'UTF-8'
                )
                : substr(
                    $rawName,
                    0,
                    200
                );
    }


    /*
     * Development/test defaults.
     */

    if ($isTestMode) {

        if ($id <= 0) {
            $id = $testId;
        }

        if ($name === '') {
            $name = $testName;
        }
    }


    /*
    |--------------------------------------------------------------------------
    | Stored asset
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
            is_array($labelData) &&
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
                ) &&
                !empty(
                    $labelAsset['name']
                )
            ) {

                $name =
                    (string)$labelAsset['name'];
            }


            if (
                $unitNo !== null &&
                is_array(
                    $labelAsset
                ) &&
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


    if ($name === '') {

        $name =
            $isTestMode
                ? $testName
                : 'Unknown';
    }


    /*
    |--------------------------------------------------------------------------
    | QR URL
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
                $_SERVER['HTTPS'] !== 'off'
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
    | Canvas
    |--------------------------------------------------------------------------
    |
    | 1x = 165 x 354
    | 3x = 495 x 1062
    |
    */

    $width =
        label_px(165);


    $height =
        label_px(354);


    $image =
        imagecreatetruecolor(
            $width,
            $height
        );


    if ($image === false) {

        throw new RuntimeException(
            'Could not create GD canvas.'
        );
    }


    /*
     * Store intended resolution in PNG metadata where GD supports it.
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
    | Branding
    |--------------------------------------------------------------------------
    */

    $font =
        label_font(
            'bold'
        );


    $labelHeading =
        (string)label_setting(
            'branding.labelHeading',
            'PROPERTY OF'
        );


    $labelOrg =
        (string)label_setting(
            'branding.orgName',
            ''
        );


    if ($labelOrg === '') {

        $labelOrg =
            (string)label_setting(
                'branding.appName',
                'Assets'
            );
    }


    /*
    |--------------------------------------------------------------------------
    | Heading
    |--------------------------------------------------------------------------
    */

    label_text(
        $image,
        $font,
        label_font_px(15),
        label_px(15),
        label_px(35),
        $black,
        $labelHeading
    );


    /*
    |--------------------------------------------------------------------------
    | Logo
    |--------------------------------------------------------------------------
    |
    | Primary:
    |     branding.logoFile
    |
    | Dev/Test fallback:
    |     ./logo.png
    |
    | Physical limits remain:
    |
    |     max width  = 140 px @ 1x
    |     max height = 3.4 mm
    |
    */

    $logo =
        null;


    $configuredLogo =
        (string)label_setting(
            'branding.logoFile',
            ''
        );


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
     * Dev/test logo fallback.
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
     * Default original QR position.
     */

    $qrY =
        label_px(70);


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
             * IMPORTANT:
             *
             * Calculate the ORIGINAL 1x logo size first.
             *
             * This preserves the existing behaviour:
             * - max width 140 px
             * - max height 3.4 mm @ 300 DPI
             * - source is not upscaled at 1x
             *
             * Afterwards the resulting size is multiplied by renderScale.
             *
             * Therefore a 3x label has precisely the same physical
             * logo size as the 1x label.
             */

            $baseMaxLogoWidth =
                140;


            $baseMaxLogoHeight =
                (int)round(
                    (
                        3.4 /
                        25.4
                    ) *
                    300
                );


            $baseLogoScale =
                min(
                    $baseMaxLogoWidth /
                        $srcLogoWidth,

                    $baseMaxLogoHeight /
                        $srcLogoHeight
                );


            /*
             * Preserve your existing:
             * don't upscale source at normal 1x size.
             */

            $baseLogoScale =
                min(
                    1,
                    $baseLogoScale
                );


            $baseTargetLogoWidth =
                max(
                    1,
                    (int)round(
                        $srcLogoWidth *
                        $baseLogoScale
                    )
                );


            $baseTargetLogoHeight =
                max(
                    1,
                    (int)round(
                        $srcLogoHeight *
                        $baseLogoScale
                    )
                );


            /*
             * Now upscale the finished physical layout.
             */

            $targetLogoWidth =
                $baseTargetLogoWidth *
                $renderScale;


            $targetLogoHeight =
                $baseTargetLogoHeight *
                $renderScale;


            /*
             * Center horizontally.
             */

            $logoX =
                (int)round(
                    (
                        $width -
                        $targetLogoWidth
                    ) / 2
                );


            $logoY =
                label_px(40);


            imagecopyresampled(
                $image,
                $logo,

                $logoX,
                $logoY,

                0,
                0,

                $targetLogoWidth,
                $targetLogoHeight,

                $srcLogoWidth,
                $srcLogoHeight
            );


            /*
             * Keep your current 1px physical logo→QR gap.
             */

            $qrY =
                max(
                    label_px(70),

                    $logoY +
                    $targetLogoHeight +
                    label_px(1)
                );
        }


        @imagedestroy(
            $logo
        );

    } else {

        /*
        |--------------------------------------------------------------------------
        | Organisation text when no logo exists
        |--------------------------------------------------------------------------
        */

        $orgSize =
            17.0;


        while (
            $orgSize > 8.0 &&
            label_text_width(
                $font,
                label_font_px($orgSize),
                $labelOrg
            ) > label_px(140)
        ) {

            $orgSize -=
                1.0;
        }


        $renderOrgSize =
            label_font_px(
                $orgSize
            );


        $orgWidth =
            label_text_width(
                $font,
                $renderOrgSize,
                $labelOrg
            );


        $orgX =
            (int)round(
                (
                    $width -
                    $orgWidth
                ) / 2
            );


        label_text(
            $image,
            $font,
            $renderOrgSize,
            $orgX,
            label_px(62),
            $black,
            $labelOrg
        );
    }


    /*
    |--------------------------------------------------------------------------
    | QR Code
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
     * QR itself is generated at the higher source resolution too.
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
            'Generated QR code could not be opened as PNG.'
        );
    }


    $qrX =
        label_px(13);


    $qrSize =
        label_px(140);


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
    | Asset name
    |--------------------------------------------------------------------------
    */

    $maxTextWidth =
        label_px(140);


    $fontSize =
        label_font_px(18);


    /*
     * A unit's own label rides along in the name block, so it wraps into the
     * same three lines instead of needing room the layout does not have.
     */

    $nameText =
        $unitNo !== null &&
        $unitLabel !== ''
            ? $name . ' – ' . $unitLabel
            : $name;


    $wrapped =
        label_wrap_text(
            $nameText,
            $font,
            $fontSize,
            $maxTextWidth
        );


    $yStart =
        label_px(240);


    $lineHeight =
        label_px(23);


    foreach (
        $wrapped
        as $line
    ) {

        if (
            $yStart >
            label_px(292)
        ) {

            break;
        }


        $textWidth =
            label_text_width(
                $font,
                $fontSize,
                $line
            );


        $x =
            (int)round(
                (
                    $width -
                    $textWidth
                ) / 2
            );


        label_text(
            $image,
            $font,
            $fontSize,
            $x,
            $yStart,
            $black,
            $line
        );


        $yStart +=
            $lineHeight;
    }


    /*
    |--------------------------------------------------------------------------
    | Bottom ID bar
    |--------------------------------------------------------------------------
    */

    imagefilledrectangle(
        $image,
        0,
        label_px(300),
        $width,
        $height,
        $black
    );


    /*
    |--------------------------------------------------------------------------
    | ID
    |--------------------------------------------------------------------------
    */

    $heavyFont =
        label_font(
            'heavy'
        );


    $idText =
        'ID: ' .
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


    $idFontSize =
        label_font_px(20);


    $idWidth =
        label_text_width(
            $heavyFont,
            $idFontSize,
            $idText
        );


    /*
     * "ID: 1234" already fills the bar edge to edge — a unit code
     * ("ID: 12345.12") ran off both ends and printed white on white. Shrink
     * until it fits rather than lose characters.
     */

    $idMaxWidth =
        $width -
        label_px(10);


    while (
        $idWidth > $idMaxWidth &&
        $idFontSize > label_font_px(9)
    ) {

        $idFontSize -=
            label_font_px(0.5);


        $idWidth =
            label_text_width(
                $heavyFont,
                $idFontSize,
                $idText
            );
    }


    $idX =
        (int)round(
            (
                $width -
                $idWidth
            ) / 2
        );


    label_text(
        $image,
        $heavyFont,
        $idFontSize,
        $idX,
        label_px(335),
        $white,
        $idText
    );


    /*
    |--------------------------------------------------------------------------
    | Output
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


    header(
        'X-Robots-Tag: noindex, nofollow'
    );


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

    label_error_png(
        $e
    );
}

?>