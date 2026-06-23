"use client";

import type { Piece, PieceType, PieceColor } from "@/lib/games/chess/types";

interface ChessPieceProps {
  piece: Piece;
  size?: number;
}

// Common gradient definitions for piece styling
const WhiteGradient = () => (
  <>
    <linearGradient id="whitePieceGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stopColor="#FFFFFF" />
      <stop offset="58%" stopColor="#F8FAFC" />
      <stop offset="100%" stopColor="#E2E8F0" />
    </linearGradient>
    <linearGradient id="whitePieceHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.5" />
      <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
    </linearGradient>
    <filter id="whiteShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="0.7" floodColor="#0F172A" floodOpacity="0.25" />
    </filter>
  </>
);

const BlackGradient = () => (
  <>
    <linearGradient id="blackPieceGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stopColor="#6B7280" />
      <stop offset="55%" stopColor="#4B5563" />
      <stop offset="100%" stopColor="#374151" />
    </linearGradient>
    <linearGradient id="blackPieceHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#CBD5E1" stopOpacity="0.22" />
      <stop offset="100%" stopColor="#CBD5E1" stopOpacity="0" />
    </linearGradient>
    <filter id="blackShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="0.8" floodColor="#000000" floodOpacity="0.32" />
    </filter>
  </>
);


const PAWN_TRACE_FILL = `M 131.0 16.0 L 112.0 26.0 L 92.0 44.0 L 83.0 57.0 L 73.0 81.0 L 70.0 98.0 L 70.0 116.0 L 74.0 136.0 L 81.0 153.0 L 89.0 165.0 L 89.0 168.0 L 91.0 168.0 L 104.0 181.0 L 105.0 186.0 L 83.0 197.0 L 74.0 205.0 L 70.0 216.0 L 70.0 223.0 L 74.0 233.0 L 81.0 239.0 L 100.0 245.0 L 110.0 246.0 L 113.0 248.0 L 110.0 290.0 L 103.0 323.0 L 97.0 341.0 L 87.0 363.0 L 73.0 367.0 L 63.0 376.0 L 58.0 388.0 L 60.0 408.0 L 34.0 425.0 L 28.0 431.0 L 22.0 441.0 L 19.0 451.0 L 19.0 466.0 L 26.0 481.0 L 16.0 490.0 L 11.0 500.0 L 10.0 541.0 L 324.0 541.0 L 323.0 501.0 L 317.0 489.0 L 308.0 482.0 L 308.0 479.0 L 315.0 465.0 L 315.0 452.0 L 313.0 444.0 L 306.0 432.0 L 296.0 422.0 L 274.0 408.0 L 276.0 391.0 L 271.0 376.0 L 261.0 367.0 L 247.0 363.0 L 241.0 351.0 L 232.0 326.0 L 224.0 290.0 L 220.0 248.0 L 224.0 246.0 L 242.0 243.0 L 254.0 238.0 L 260.0 232.0 L 264.0 220.0 L 263.0 212.0 L 255.0 200.0 L 246.0 194.0 L 227.0 185.0 L 227.0 183.0 L 244.0 166.0 L 252.0 154.0 L 259.0 138.0 L 262.0 126.0 L 263.0 93.0 L 260.0 79.0 L 256.0 70.0 L 256.0 65.0 L 253.0 63.0 L 248.0 53.0 L 234.0 36.0 L 217.0 23.0 L 203.0 16.0 L 180.0 10.0 L 154.0 10.0 Z`;
const PAWN_TRACE_DETAIL = `M 131.0 16.0 L 112.0 26.0 L 103.0 33.0 L 92.0 44.0 L 83.0 57.0 L 77.0 69.0 L 73.0 81.0 L 73.0 85.0 L 71.0 91.0 L 71.0 97.0 L 70.0 98.0 L 70.0 116.0 L 71.0 117.0 L 72.0 128.0 L 76.0 142.0 L 85.0 160.0 L 90.0 166.0 L 89.0 168.0 L 90.0 167.0 L 96.0 174.0 L 105.0 182.0 L 104.0 183.0 L 105.0 182.0 L 107.0 183.0 L 108.0 185.0 L 102.0 187.0 L 80.0 199.0 L 74.0 205.0 L 72.0 209.0 L 70.0 216.0 L 70.0 223.0 L 74.0 233.0 L 81.0 239.0 L 92.0 243.0 L 104.0 245.0 L 105.0 246.0 L 110.0 246.0 L 114.0 248.0 L 113.0 250.0 L 113.0 262.0 L 112.0 263.0 L 112.0 273.0 L 111.0 274.0 L 110.0 290.0 L 109.0 291.0 L 109.0 296.0 L 108.0 297.0 L 108.0 301.0 L 107.0 302.0 L 107.0 306.0 L 106.0 307.0 L 106.0 311.0 L 105.0 312.0 L 103.0 323.0 L 97.0 341.0 L 87.0 363.0 L 73.0 367.0 L 63.0 376.0 L 60.0 381.0 L 58.0 388.0 L 58.0 396.0 L 59.0 397.0 L 60.0 408.0 L 34.0 425.0 L 28.0 431.0 L 22.0 441.0 L 19.0 451.0 L 19.0 466.0 L 22.0 474.0 L 27.0 481.0 L 22.0 484.0 L 16.0 490.0 L 11.0 500.0 L 11.0 503.0 L 10.0 504.0 L 10.0 541.0 L 324.0 541.0 L 324.0 506.0 L 323.0 505.0 L 323.0 501.0 L 317.0 489.0 L 307.0 481.0 L 311.0 475.0 L 315.0 465.0 L 315.0 452.0 L 314.0 451.0 L 313.0 444.0 L 306.0 432.0 L 296.0 422.0 L 282.0 413.0 L 277.0 411.0 L 274.0 408.0 L 276.0 391.0 L 275.0 390.0 L 275.0 385.0 L 271.0 376.0 L 261.0 367.0 L 247.0 363.0 L 241.0 351.0 L 232.0 326.0 L 232.0 323.0 L 230.0 319.0 L 229.0 311.0 L 227.0 306.0 L 225.0 291.0 L 224.0 290.0 L 220.0 248.0 L 224.0 246.0 L 229.0 246.0 L 230.0 245.0 L 242.0 243.0 L 254.0 238.0 L 257.0 236.0 L 260.0 232.0 L 263.0 226.0 L 263.0 221.0 L 264.0 220.0 L 263.0 219.0 L 263.0 212.0 L 260.0 206.0 L 255.0 200.0 L 246.0 194.0 L 232.0 187.0 L 230.0 187.0 L 226.0 184.0 L 239.0 172.0 L 247.0 162.0 L 252.0 154.0 L 259.0 138.0 L 259.0 135.0 L 262.0 126.0 L 262.0 121.0 L 263.0 120.0 L 263.0 93.0 L 262.0 92.0 L 262.0 87.0 L 261.0 86.0 L 260.0 79.0 L 255.0 67.0 L 256.0 65.0 L 255.0 66.0 L 248.0 53.0 L 234.0 36.0 L 217.0 23.0 L 203.0 16.0 L 186.0 11.0 L 181.0 11.0 L 180.0 10.0 L 154.0 10.0 L 153.0 11.0 L 148.0 11.0 Z M 129.0 251.0 L 145.0 252.0 L 146.0 253.0 L 189.0 253.0 L 190.0 252.0 L 199.0 252.0 L 200.0 251.0 L 205.0 251.0 L 206.0 252.0 L 207.0 274.0 L 208.0 275.0 L 208.0 282.0 L 209.0 283.0 L 209.0 289.0 L 210.0 290.0 L 212.0 307.0 L 214.0 312.0 L 216.0 324.0 L 219.0 331.0 L 219.0 334.0 L 224.0 349.0 L 226.0 352.0 L 228.0 359.0 L 238.0 378.0 L 240.0 379.0 L 250.0 379.0 L 253.0 380.0 L 258.0 384.0 L 261.0 390.0 L 260.0 402.0 L 258.0 407.0 L 258.0 413.0 L 260.0 417.0 L 268.0 423.0 L 284.0 432.0 L 289.0 436.0 L 297.0 445.0 L 300.0 453.0 L 300.0 463.0 L 298.0 468.0 L 293.0 473.0 L 289.0 475.0 L 45.0 475.0 L 41.0 473.0 L 36.0 468.0 L 34.0 464.0 L 34.0 452.0 L 36.0 446.0 L 48.0 433.0 L 69.0 421.0 L 74.0 417.0 L 76.0 413.0 L 76.0 408.0 L 73.0 398.0 L 73.0 390.0 L 75.0 385.0 L 81.0 380.0 L 95.0 378.0 L 101.0 369.0 L 101.0 367.0 L 107.0 356.0 L 116.0 331.0 L 116.0 328.0 L 122.0 307.0 L 123.0 295.0 L 125.0 288.0 L 125.0 281.0 L 126.0 280.0 L 126.0 272.0 L 127.0 271.0 L 127.0 260.0 L 128.0 259.0 L 128.0 252.0 Z M 123.0 37.0 L 134.0 31.0 L 149.0 26.0 L 154.0 26.0 L 155.0 25.0 L 179.0 25.0 L 180.0 26.0 L 184.0 26.0 L 197.0 30.0 L 215.0 40.0 L 227.0 51.0 L 237.0 64.0 L 243.0 76.0 L 248.0 93.0 L 249.0 111.0 L 248.0 112.0 L 247.0 125.0 L 242.0 140.0 L 232.0 157.0 L 223.0 167.0 L 216.0 173.0 L 209.0 177.0 L 205.0 181.0 L 203.0 187.0 L 205.0 192.0 L 207.0 194.0 L 229.0 202.0 L 243.0 210.0 L 249.0 217.0 L 249.0 221.0 L 247.0 225.0 L 233.0 230.0 L 218.0 232.0 L 217.0 233.0 L 211.0 233.0 L 210.0 234.0 L 204.0 234.0 L 203.0 235.0 L 193.0 235.0 L 192.0 236.0 L 143.0 236.0 L 142.0 235.0 L 132.0 235.0 L 131.0 234.0 L 124.0 234.0 L 123.0 233.0 L 117.0 233.0 L 116.0 232.0 L 101.0 230.0 L 97.0 228.0 L 91.0 227.0 L 86.0 224.0 L 85.0 222.0 L 85.0 216.0 L 88.0 212.0 L 95.0 207.0 L 105.0 202.0 L 127.0 194.0 L 130.0 190.0 L 130.0 183.0 L 129.0 181.0 L 113.0 169.0 L 101.0 156.0 L 95.0 147.0 L 88.0 130.0 L 88.0 127.0 L 86.0 122.0 L 86.0 117.0 L 85.0 116.0 L 85.0 97.0 L 86.0 96.0 L 87.0 87.0 L 91.0 75.0 L 96.0 65.0 L 104.0 54.0 L 116.0 42.0 Z M 25.0 505.0 L 28.0 499.0 L 32.0 495.0 L 38.0 492.0 L 296.0 492.0 L 302.0 495.0 L 308.0 503.0 L 309.0 506.0 L 309.0 524.0 L 307.0 526.0 L 26.0 526.0 L 25.0 525.0 Z`;
const PAWN_TRACE_TRANSFORM = "translate(10.211 2.250) scale(0.07337)";

const KNIGHT_TRACE_FILL = `M 140.0 10.0 L 147.0 72.0 L 120.0 86.0 L 101.0 101.0 L 96.0 108.0 L 82.0 138.0 L 16.0 208.0 L 12.0 217.0 L 10.0 227.0 L 15.0 260.0 L 19.0 268.0 L 30.0 278.0 L 59.0 290.0 L 73.0 292.0 L 86.0 289.0 L 96.0 283.0 L 111.0 263.0 L 119.0 255.0 L 125.0 252.0 L 164.0 252.0 L 184.0 247.0 L 188.0 247.0 L 189.0 251.0 L 184.0 269.0 L 172.0 290.0 L 165.0 299.0 L 112.0 353.0 L 101.0 368.0 L 88.0 392.0 L 80.0 414.0 L 75.0 446.0 L 76.0 476.0 L 74.0 478.0 L 61.0 482.0 L 53.0 488.0 L 44.0 502.0 L 42.0 509.0 L 42.0 548.0 L 368.0 548.0 L 368.0 511.0 L 363.0 496.0 L 352.0 484.0 L 345.0 480.0 L 330.0 476.0 L 331.0 471.0 L 348.0 433.0 L 362.0 392.0 L 373.0 345.0 L 377.0 314.0 L 378.0 273.0 L 375.0 242.0 L 369.0 212.0 L 355.0 171.0 L 345.0 151.0 L 331.0 129.0 L 306.0 102.0 L 293.0 92.0 L 277.0 82.0 L 251.0 71.0 L 231.0 66.0 L 218.0 65.0 L 203.0 46.0 L 182.0 27.0 L 166.0 18.0 Z`;
const KNIGHT_TRACE_DETAIL = `M 140.0 10.0 L 147.0 72.0 L 120.0 86.0 L 107.0 95.0 L 101.0 101.0 L 96.0 108.0 L 89.0 123.0 L 89.0 125.0 L 82.0 138.0 L 16.0 208.0 L 12.0 217.0 L 12.0 221.0 L 10.0 227.0 L 15.0 260.0 L 19.0 268.0 L 30.0 278.0 L 59.0 290.0 L 73.0 292.0 L 74.0 291.0 L 80.0 291.0 L 86.0 289.0 L 96.0 283.0 L 101.0 278.0 L 111.0 263.0 L 119.0 255.0 L 125.0 252.0 L 128.0 252.0 L 129.0 251.0 L 164.0 252.0 L 165.0 251.0 L 172.0 251.0 L 173.0 250.0 L 180.0 249.0 L 187.0 246.0 L 189.0 247.0 L 189.0 251.0 L 184.0 269.0 L 178.0 281.0 L 165.0 299.0 L 112.0 353.0 L 101.0 368.0 L 88.0 392.0 L 80.0 414.0 L 80.0 418.0 L 79.0 419.0 L 78.0 428.0 L 77.0 429.0 L 76.0 445.0 L 75.0 446.0 L 75.0 470.0 L 76.0 471.0 L 76.0 476.0 L 74.0 478.0 L 71.0 478.0 L 61.0 482.0 L 53.0 488.0 L 47.0 496.0 L 44.0 502.0 L 44.0 505.0 L 42.0 509.0 L 42.0 548.0 L 368.0 548.0 L 368.0 511.0 L 363.0 496.0 L 352.0 484.0 L 347.0 481.0 L 339.0 478.0 L 330.0 477.0 L 329.0 476.0 L 348.0 433.0 L 362.0 392.0 L 362.0 389.0 L 364.0 385.0 L 364.0 382.0 L 366.0 378.0 L 366.0 374.0 L 369.0 365.0 L 372.0 346.0 L 373.0 345.0 L 375.0 325.0 L 376.0 324.0 L 376.0 315.0 L 377.0 314.0 L 378.0 273.0 L 377.0 272.0 L 377.0 260.0 L 376.0 259.0 L 375.0 242.0 L 374.0 241.0 L 373.0 230.0 L 372.0 229.0 L 369.0 212.0 L 367.0 208.0 L 367.0 205.0 L 365.0 201.0 L 365.0 198.0 L 361.0 186.0 L 359.0 183.0 L 355.0 171.0 L 345.0 151.0 L 331.0 129.0 L 322.0 118.0 L 306.0 102.0 L 293.0 92.0 L 277.0 82.0 L 251.0 71.0 L 237.0 68.0 L 236.0 67.0 L 232.0 67.0 L 231.0 66.0 L 218.0 65.0 L 203.0 46.0 L 193.0 36.0 L 182.0 27.0 L 166.0 18.0 Z M 156.0 29.0 L 160.0 30.0 L 173.0 37.0 L 183.0 45.0 L 193.0 55.0 L 210.0 77.0 L 223.0 78.0 L 224.0 79.0 L 233.0 80.0 L 251.0 85.0 L 271.0 94.0 L 292.0 108.0 L 311.0 126.0 L 327.0 147.0 L 328.0 150.0 L 332.0 155.0 L 347.0 186.0 L 358.0 223.0 L 358.0 227.0 L 359.0 228.0 L 359.0 232.0 L 361.0 238.0 L 361.0 243.0 L 362.0 244.0 L 362.0 250.0 L 363.0 251.0 L 364.0 273.0 L 365.0 274.0 L 364.0 315.0 L 363.0 316.0 L 363.0 323.0 L 362.0 324.0 L 360.0 344.0 L 359.0 345.0 L 357.0 359.0 L 356.0 360.0 L 351.0 383.0 L 349.0 387.0 L 349.0 390.0 L 332.0 438.0 L 328.0 445.0 L 325.0 454.0 L 319.0 464.0 L 89.0 464.0 L 88.0 463.0 L 88.0 444.0 L 89.0 443.0 L 89.0 435.0 L 90.0 434.0 L 92.0 420.0 L 94.0 416.0 L 94.0 413.0 L 97.0 404.0 L 105.0 387.0 L 117.0 368.0 L 131.0 351.0 L 173.0 310.0 L 184.0 296.0 L 193.0 281.0 L 193.0 279.0 L 196.0 274.0 L 201.0 255.0 L 214.0 247.0 L 229.0 231.0 L 236.0 218.0 L 239.0 208.0 L 239.0 203.0 L 240.0 202.0 L 240.0 195.0 L 237.0 188.0 L 233.0 184.0 L 230.0 183.0 L 222.0 184.0 L 217.0 190.0 L 215.0 201.0 L 206.0 217.0 L 198.0 225.0 L 188.0 232.0 L 175.0 237.0 L 165.0 238.0 L 164.0 239.0 L 127.0 238.0 L 126.0 239.0 L 119.0 240.0 L 109.0 246.0 L 100.0 256.0 L 94.0 266.0 L 86.0 274.0 L 78.0 278.0 L 65.0 278.0 L 46.0 271.0 L 43.0 269.0 L 41.0 269.0 L 33.0 264.0 L 28.0 257.0 L 26.0 245.0 L 25.0 244.0 L 24.0 233.0 L 23.0 232.0 L 24.0 222.0 L 28.0 214.0 L 91.0 148.0 L 94.0 144.0 L 101.0 130.0 L 103.0 123.0 L 110.0 111.0 L 117.0 104.0 L 124.0 99.0 L 160.0 80.0 L 161.0 78.0 L 160.0 77.0 L 160.0 67.0 L 159.0 66.0 L 157.0 41.0 L 156.0 40.0 L 156.0 34.0 L 155.0 33.0 L 155.0 30.0 Z M 54.0 516.0 L 55.0 515.0 L 56.0 507.0 L 60.0 500.0 L 68.0 493.0 L 76.0 490.0 L 334.0 490.0 L 343.0 494.0 L 347.0 497.0 L 354.0 508.0 L 354.0 511.0 L 355.0 512.0 L 355.0 534.0 L 354.0 535.0 L 56.0 535.0 L 54.0 533.0 Z M 160.0 121.0 L 157.0 121.0 L 156.0 120.0 L 137.0 120.0 L 131.0 122.0 L 125.0 126.0 L 120.0 132.0 L 117.0 138.0 L 117.0 141.0 L 127.0 147.0 L 130.0 147.0 L 131.0 148.0 L 141.0 148.0 L 147.0 145.0 L 153.0 139.0 L 158.0 130.0 Z`;
const KNIGHT_TRACE_TRANSFORM = "translate(6.843 0) scale(0.08050)";

interface TracedPieceSVGProps {
  fill: string;
  stroke: string;
  filter: string;
  fillPath: string;
  detailPath: string;
  transform: string;
}

function TracedPieceSVG({ fill, stroke, filter, fillPath, detailPath, transform }: TracedPieceSVGProps) {
  return (
    <g filter={filter} transform={transform}>
      <path d={fillPath} fill={fill} />
      <path d={detailPath} fill={stroke} fillRule="evenodd" clipRule="evenodd" />
    </g>
  );
}

// Pawn SVG
function PawnSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";

  return (
    <TracedPieceSVG
      fill={fill}
      stroke={stroke}
      filter={filter}
      fillPath={PAWN_TRACE_FILL}
      detailPath={PAWN_TRACE_DETAIL}
      transform={PAWN_TRACE_TRANSFORM}
    />
  );
}

// Knight SVG
function KnightSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";

  return (
    <TracedPieceSVG
      fill={fill}
      stroke={stroke}
      filter={filter}
      fillPath={KNIGHT_TRACE_FILL}
      detailPath={KNIGHT_TRACE_DETAIL}
      transform={KNIGHT_TRACE_TRANSFORM}
    />
  );
}

// Bishop SVG
function BishopSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Base */}
      <ellipse cx="22.5" cy="40" rx="12" ry="3.5" fill={fill} stroke={stroke} strokeWidth="1" />
      <path
        d="M12 39 Q14 35 18 35 L27 35 Q31 35 33 39"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Stem and collar */}
      <path
        d="M16 36 L18 30 L27 30 L29 36 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.8"
      />
      <ellipse cx="22.5" cy="30" rx="8" ry="2.4" fill={fill} stroke={stroke} strokeWidth="0.9" />
      {/* Mitre body */}
      <path
        d="M16 30 Q13.5 23 17 16 Q19.5 11 22.5 8 Q25.5 11 28 16 Q31.5 23 29 30 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Mitre slit */}
      <path
        d="M24.5 10 Q20 16 19 25"
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth="1.6"
      />
      {/* Top ball */}
      <circle cx="22.5" cy="6" r="2.5" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Highlight */}
      <path
        d="M17.5 22 Q19 15 22 11"
        fill="none"
        stroke={highlight}
        strokeLinecap="round"
        strokeWidth="2"
        opacity="0.5"
      />
    </g>
  );
}

// Rook SVG
function RookSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Base */}
      <path
        d="M10 40 L10 36 Q10 34 12 34 L33 34 Q35 34 35 36 L35 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Body */}
      <path
        d="M12 34 L14 18 L31 18 L33 34 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Top platform */}
      <path
        d="M13 18 L13 14 L32 14 L32 18 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Battlements */}
      <path
        d="M13 14 L13 8 L17 8 L17 11 L20 11 L20 8 L25 8 L25 11 L28 11 L28 8 L32 8 L32 14"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Highlight */}
      <path
        d="M16 30 L17 20"
        fill="none"
        stroke={highlight}
        strokeWidth="2"
        opacity="0.5"
      />
    </g>
  );
}

// Queen SVG
function QueenSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Base */}
      <ellipse cx="22.5" cy="40" rx="12" ry="4" fill={fill} stroke={stroke} strokeWidth="1" />
      {/* Lower body */}
      <path
        d="M12 40 L14 30 L31 30 L33 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Collar */}
      <ellipse cx="22.5" cy="30" rx="8.5" ry="2.5" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Upper body with crown points */}
      <path
        d="M14 30 Q12 24 10 12 L14 18 L18 8 L22.5 16 L27 8 L31 18 L35 12 Q33 24 31 30 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Crown jewels (balls on points) */}
      <circle cx="10" cy="11" r="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
      <circle cx="18" cy="7" r="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
      <circle cx="22.5" cy="5" r="2.5" fill={fill} stroke={stroke} strokeWidth="0.6" />
      <circle cx="27" cy="7" r="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
      <circle cx="35" cy="11" r="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
      {/* Highlight */}
      <path
        d="M16 26 Q18 20 20 16"
        fill="none"
        stroke={highlight}
        strokeWidth="2"
        opacity="0.5"
      />
    </g>
  );
}

// King SVG
function KingSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Base */}
      <ellipse cx="22.5" cy="40" rx="12" ry="4" fill={fill} stroke={stroke} strokeWidth="1" />
      {/* Lower body */}
      <path
        d="M12 40 L14 30 L31 30 L33 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Collar */}
      <ellipse cx="22.5" cy="30" rx="8.5" ry="2.5" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Upper body */}
      <path
        d="M14 30 Q12 22 14 16 L16 14 Q18 12 22.5 12 Q27 12 29 14 L31 16 Q33 22 31 30 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Crown band */}
      <path
        d="M15 16 Q14 14 16 12 L18 14 L21 12 L22.5 14 L24 12 L27 14 L29 12 Q31 14 30 16 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.8"
      />
      {/* Cross vertical */}
      <path
        d="M22.5 12 L22.5 4"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M22.5 12 L22.5 4"
        stroke={fill}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Cross horizontal */}
      <path
        d="M18 7 L27 7"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M18 7 L27 7"
        stroke={fill}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Highlight */}
      <path
        d="M17 26 Q18 20 20 16"
        fill="none"
        stroke={highlight}
        strokeWidth="2"
        opacity="0.5"
      />
    </g>
  );
}

// Map piece types to their SVG components
const PieceSVGComponents: Record<PieceType, React.FC<{ color: PieceColor }>> = {
  pawn: PawnSVG,
  knight: KnightSVG,
  bishop: BishopSVG,
  rook: RookSVG,
  queen: QueenSVG,
  king: KingSVG,
};

export function ChessPiece({ piece, size }: ChessPieceProps) {
  const PieceSVG = PieceSVGComponents[piece.type];

  // If size is provided, use fixed dimensions; otherwise fill container
  const sizeProps = size
    ? { width: size, height: size }
    : { width: "100%", height: "100%" };

  return (
    <svg
      {...sizeProps}
      viewBox="0 0 45 45"
      xmlns="http://www.w3.org/2000/svg"
      className="chess-piece"
      style={{ display: "block", maxWidth: "100%", maxHeight: "100%", width: "100%", height: "100%" }}
      preserveAspectRatio="xMidYMid meet"
      data-testid="chess-piece"
    >
      <defs>
        {piece.color === "white" ? <WhiteGradient /> : <BlackGradient />}
      </defs>
      <PieceSVG color={piece.color} />
    </svg>
  );
}

export default ChessPiece;
