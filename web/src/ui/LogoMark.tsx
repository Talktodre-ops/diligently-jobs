import s from './LogoMark.module.css'

/**
 * The "d." mark: the Fraunces d and the persimmon full stop on a tile. Sits in
 * front of the text wordmark to make the full logo, "d. diligently.". Sized in
 * em, so it follows the wordmark's font size. Decorative: the wordmark text
 * beside it carries the name. Outlines come from docs/brand/mark.svg.
 */
export function LogoMark() {
  return (
    <svg className={s.mark} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <rect width="512" height="512" rx="116" className={s.tile} />
      <path
        className={s.letter}
        transform="translate(92.15 398.59) scale(0.19506 -0.19506)"
        d="M800 167 791 172V1255Q791 1280 783.5 1291.0Q776 1302 758 1305L706 1309Q688 1314 680.0 1323.0Q672 1332 672 1346Q672 1362 681.5 1372.0Q691 1382 718 1392L904 1460Q942 1474 965.0 1480.5Q988 1487 1009 1487Q1040 1487 1056.0 1469.5Q1072 1452 1072 1423V160Q1072 129 1081.0 114.5Q1090 100 1108 94L1146 84Q1165 78 1174.0 67.5Q1183 57 1183 41Q1183 22 1169.5 11.0Q1156 0 1128 0H921Q869 0 834.5 33.5Q800 67 800 121ZM71 447Q71 607 134.5 724.5Q198 842 307.0 906.0Q416 970 551 970Q670 970 762.0 914.5Q854 859 914 752L845 695Q796 777 734.5 817.0Q673 857 602 857Q534 857 480.0 816.5Q426 776 395.0 692.5Q364 609 364 478Q364 356 394.0 276.0Q424 196 476.5 156.5Q529 117 596 117Q669 117 732.0 160.5Q795 204 848 294L893 237Q814 114 710.5 44.5Q607 -25 482 -25Q364 -25 271.0 35.5Q178 96 124.5 202.5Q71 309 71 447Z"
      />
      <circle cx="371.28" cy="368.16" r="34.72" className={s.stop} />
    </svg>
  )
}
