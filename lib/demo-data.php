<?php
/**
 * The optional demo dataset the installer can seed a fresh data.json with.
 *
 * Returns a closure so the records can be built against the settings the
 * operator just chose — the currency they price in, the loan defaults that
 * decide when the sample reservation starts — instead of hardcoding EUR and a
 * date in the past.
 *
 * Every value here is already in the shape trax_normalize_data() produces:
 * the key order matches the normalisers, prices are rounded floats, the ISO
 * stamps are the UTC form trax_iso() emits. Running the result through the
 * normaliser twice must change nothing, which is what makes seeded data
 * indistinguishable from data the app wrote itself.
 *
 * A few records carry purchase and warranty dates. They are built relative to
 * the install date rather than hardcoded, so the demo shows a warranty that is
 * still running and one that has already lapsed however long the download sat
 * on a shelf. They are plain calendar days formatted with date(), which is what
 * trax_date() reads them back as in any timezone.
 *
 * Nothing in here names a real person or a real organisation.
 *
 * @return callable(array): array  fn(array $settings): array
 */

declare(strict_types=1);

return function (array $settings): array {
    $currency = (string)($settings['defaults']['currency'] ?? 'EUR');
    $loanDays = (int)($settings['defaults']['loanDays'] ?? 7);
    $startHr  = (int)($settings['defaults']['reservationStartHour'] ?? 9);
    $dueHr    = (int)($settings['defaults']['dueHour'] ?? 18);

    /** One asset, with every field the schema knows filled in the schema's order. */
    $item = static function (
        int $id,
        string $name,
        string $category,
        string $location,
        float $price,
        int $quantity,
        string $condition,
        string $notes,
        array $tags,
        string $currency,
        ?string $purchasedAt = null,
        ?string $warrantyUntil = null
    ): array {
        return [
            'id'            => $id,
            'name'          => $name,
            'status'        => 'FREE',
            'notes'         => $notes,
            'category'      => $category,
            'location'      => $location,
            'quantity'      => $quantity,
            'kind'          => 'ITEM',
            'members'       => [],
            'serial'        => '',
            'supplier'      => '',
            'purchasedAt'   => $purchasedAt,
            'price'         => round($price, 2),
            'currency'      => $currency,
            'warrantyUntil' => $warrantyUntil,
            'condition'     => $condition,
            'photo'         => null,
            'tags'          => $tags,
            'conditionLog'  => [],
            'documents'     => [],
        ];
    };

    // Calendar days, not instants: date() so they read back unchanged through
    // trax_date() wherever the operator is.
    $ago   = static fn(string $rel): string => date('Y-m-d', strtotime($rel) ?: time());

    $assets = [
        $item(1, 'Projector', 'Audio/Video', 'Store room', 620.0, 1, 'GOOD',
            'Full HD, HDMI and USB-C. Remote is in the case.', ['presentation'], $currency,
            $ago('-2 years'), $ago('-1 year')),
        $item(2, 'Laptop', 'Computers', 'Office cupboard', 940.0, 2, 'GOOD',
            'Loan machine. Wiped and re-imaged after every return.', ['presentation'], $currency,
            $ago('-18 months'), $ago('+6 months')),
        $item(3, 'Camera body', 'Photo', 'Store room', 1180.0, 1, 'GOOD',
            'Battery and charger live in the same box.', ['photo'], $currency,
            $ago('-10 months'), $ago('+14 months')),
        $item(4, 'Tripod', 'Photo', 'Store room', 145.0, 3, 'FAIR',
            'One of the three has a stiff leg clamp.', ['photo'], $currency),
        $item(5, 'Extension cord 10 m', 'Power', 'Store room', 24.5, 6, 'GOOD',
            'Tested annually. Coil it properly before it goes back.', ['cable'], $currency),
        $item(6, 'Folding table', 'Furniture', 'Garage', 78.0, 8, 'GOOD',
            '180 x 75 cm. Two people to carry, please.', ['event'], $currency),
        $item(7, 'PA speaker', 'Audio/Video', 'Garage', 410.0, 2, 'GOOD',
            'Active speaker, stand and XLR cable included.', ['event'], $currency),
    ];

    // A kit: one record that lends its members out together. The two members
    // are real assets above, which is what makes the availability logic on the
    // demo data behave the way it would on real data.
    $assets[] = [
        'id'            => 8,
        'name'          => 'Presentation kit',
        'status'        => 'FREE',
        'notes'         => 'Projector plus an extension cord — everything a meeting room needs.',
        'category'      => 'Audio/Video',
        'location'      => 'Store room',
        'quantity'      => 1,
        'kind'          => 'SET',
        'members'       => [
            ['assetId' => 1, 'qty' => 1],
            ['assetId' => 5, 'qty' => 1],
        ],
        'serial'        => '',
        'supplier'      => '',
        'purchasedAt'   => null,
        'price'         => null,
        'currency'      => $currency,
        'warrantyUntil' => null,
        'condition'     => 'GOOD',
        'photo'         => null,
        'tags'          => ['presentation'],
        'conditionLog'  => [],
        'documents'     => [],
    ];

    // One reservation, far enough ahead that it is still in the future whenever
    // the demo is looked at. The customer is a placeholder, not a person.
    $day     = 24 * 60 * 60;
    $startTs = strtotime('+7 days 00:00') ?: time() + 7 * $day;
    $startTs += $startHr * 3600;
    $endTs   = $startTs - $startHr * 3600 + $loanDays * $day + $dueHr * 3600;

    $reservations = [[
        'id'            => 1,
        'assetIds'      => [3, 4],
        'items'         => [
            ['assetId' => 3, 'qty' => 1],
            ['assetId' => 4, 'qty' => 1],
        ],
        'setIds'        => [],
        'customerName'  => 'Sample Customer',
        'customerEmail' => 'sample@example.com',
        'startAt'       => gmdate('Y-m-d\TH:i:s.000\Z', $startTs),
        'endAt'         => gmdate('Y-m-d\TH:i:s.000\Z', $endTs),
        'status'        => 'ACTIVE',
        'notes'         => 'Sample reservation — delete it once you start entering your own.',
        'createdAt'     => gmdate('Y-m-d\TH:i:s.000\Z'),
        'convertedAt'   => null,
        'completedAt'   => null,
        'cancelledAt'   => null,
    ]];

    return [
        'rev'           => 1,
        'assets'        => $assets,
        'events'        => [],
        'reservations'  => $reservations,
        'rentalHistory' => [],
        'bookings'      => [],
        'settings'      => $settings,
        'cronState'     => [
            'lastRunAt'    => null,
            'lastDigestOn' => null,
        ],
    ];
};
