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
      <stop offset="0%" stopColor="#FFFEF5" />
      <stop offset="50%" stopColor="#F5F0E0" />
      <stop offset="100%" stopColor="#E8E0D0" />
    </linearGradient>
    <linearGradient id="whitePieceHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
      <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
    </linearGradient>
    <filter id="whiteShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#000000" floodOpacity="0.2" />
    </filter>
  </>
);

const BlackGradient = () => (
  <>
    <linearGradient id="blackPieceGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stopColor="#4A4A4A" />
      <stop offset="50%" stopColor="#2D2D2D" />
      <stop offset="100%" stopColor="#1A1A1A" />
    </linearGradient>
    <linearGradient id="blackPieceHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stopColor="#808080" stopOpacity="0.4" />
      <stop offset="100%" stopColor="#808080" stopOpacity="0" />
    </linearGradient>
    <filter id="blackShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#000000" floodOpacity="0.35" />
    </filter>
  </>
);

// Pawn SVG
function PawnSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Base */}
      <ellipse cx="22.5" cy="40" rx="10" ry="3" fill={fill} stroke={stroke} strokeWidth="1" />
      {/* Stem */}
      <path
        d="M16 40 L18 28 Q18 25 22.5 25 Q27 25 27 28 L29 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Collar */}
      <ellipse cx="22.5" cy="25" rx="5" ry="2" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Head */}
      <circle cx="22.5" cy="17" r="7" fill={fill} stroke={stroke} strokeWidth="1" />
      {/* Highlight */}
      <circle cx="20" cy="14" r="3" fill={highlight} opacity="0.6" />
    </g>
  );
}

// Knight SVG
function KnightSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Wide base */}
      <path
        d="M9 40 L11 35 Q12 33 16 33 L32 33 Q35 33 36 36 L37 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Chest and neck */}
      <path
        d="M15 34 Q16 28 14 23 Q12 18 16 13 Q20 8 27 7 Q32 7 35 12 Q37 16 34 21 Q31 25 28 28 Q31 30 32 34 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Head profile */}
      <path
        d="M18 14 Q23 12 28 13 Q31 14 32 18 Q30 17 28 18 Q26 19 25 22 Q24 25 22 27 Q20 29 17 30 Q18 25 17 22 Q15 18 18 14 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.9"
      />
      {/* Ear and muzzle */}
      <path
        d="M25 8 L27 3.5 L30 8.5"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.8"
      />
      <path
        d="M31 18 Q35 18 36 21 Q34 23 31 22"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.9"
      />
      {/* Mane cuts */}
      <path
        d="M18 13 Q19 17 17 20 M20 11 Q21 16 19 20 M22 9 Q24 14 21 19"
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth="1.1"
        opacity="0.9"
      />
      <circle cx="29" cy="15" r="1.2" fill={stroke} />
      <circle cx="34" cy="20.5" r="0.8" fill={stroke} />
      <path
        d="M18 18 Q20 12 27 10"
        fill="none"
        stroke={highlight}
        strokeLinecap="round"
        strokeWidth="2"
        opacity="0.5"
      />
    </g>
  );
}

// Bishop SVG
function BishopSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
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
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
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
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
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
  const stroke = color === "white" ? "#5C4033" : "#1A1A1A";
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
