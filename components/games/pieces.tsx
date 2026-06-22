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
      {/* Base */}
      <path
        d="M10 40 L10 36 Q10 34 14 34 L31 34 Q35 34 35 36 L35 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Body/Neck */}
      <path
        d="M14 34 L14 24 Q12 18 16 12 L22 8 Q28 6 30 10 L32 14 Q34 18 32 22 L30 26 Q32 30 31 34 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Mane */}
      <path
        d="M16 12 Q18 14 17 18 Q16 22 14 24"
        fill="none"
        stroke={stroke}
        strokeWidth="1.2"
      />
      {/* Ear */}
      <path
        d="M22 8 L24 4 L26 8"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.8"
      />
      {/* Eye */}
      <circle cx="27" cy="14" r="1.5" fill={stroke} />
      {/* Nostril */}
      <circle cx="32" cy="18" r="1" fill={stroke} />
      {/* Highlight */}
      <path
        d="M18 16 Q20 12 24 10"
        fill="none"
        stroke={highlight}
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
      <ellipse cx="22.5" cy="40" rx="11" ry="3.5" fill={fill} stroke={stroke} strokeWidth="1" />
      {/* Stem */}
      <path
        d="M14 40 L16 30 L18 30 L17 40 Z M28 40 L27 30 L29 30 L31 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="0.5"
      />
      {/* Body */}
      <path
        d="M16 30 Q14 22 18 14 Q20 10 22.5 8 Q25 10 27 14 Q31 22 29 30 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
      />
      {/* Collar band */}
      <ellipse cx="22.5" cy="30" rx="6.5" ry="2" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Mitre slit */}
      <path
        d="M22.5 8 L22.5 18"
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
      />
      {/* Top ball */}
      <circle cx="22.5" cy="6" r="2.5" fill={fill} stroke={stroke} strokeWidth="0.8" />
      {/* Highlight */}
      <path
        d="M18 20 Q20 14 22 12"
        fill="none"
        stroke={highlight}
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