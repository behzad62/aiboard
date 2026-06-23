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

// Pawn SVG
function PawnSVG({ color }: { color: PieceColor }) {
  const fill = color === "white" ? "url(#whitePieceGradient)" : "url(#blackPieceGradient)";
  const stroke = color === "white" ? "#64748B" : "#1F2937";
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
  const stroke = color === "white" ? "#64748B" : "#1F2937";
  const filter = color === "white" ? "url(#whiteShadow)" : "url(#blackShadow)";
  const highlight = color === "white" ? "url(#whitePieceHighlight)" : "url(#blackPieceHighlight)";

  return (
    <g filter={filter}>
      {/* Plinth */}
      <path
        d="M9.5 40 L12 34.5 Q13 33 16 33 L31 33 Q34 33 35.5 35.5 L37 40 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.45"
      />
      {/* Horse head and neck */}
      <path
        d="M15 34.5 Q16 29 18 24 Q19.5 20 22 16.5 Q22.5 12 25.5 9.5 Q27 8.2 28.8 8 L30 4.8 L32.5 9.2 Q35.5 10.2 36.8 13.2 Q38 16.2 36 18.8 Q34.5 20.8 31.2 21.1 L28.4 21.4 Q26.3 21.7 25.2 24 Q24 26.8 26.5 30 Q28.2 32.2 31 34.5 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.45"
      />
      {/* Neck front */}
      <path
        d="M18 34 Q19 27 22.2 21.5 Q22.5 26.5 25 30 Q26.3 31.8 28.8 34 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.1"
      />
      {/* Mane cuts */}
      <path
        d="M24.3 10.5 Q22.6 13 22.2 16.2 M21.5 15 L18.9 18.8 L21.6 18.7 M20.2 20 L17.8 24.2 L21.4 23.5 M19.5 25.2 L18 29.8"
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
        opacity="0.9"
      />
      {/* Jaw and face details */}
      <path
        d="M31.5 18.2 Q33.8 18.2 35.7 17.3 M28.6 21.3 Q31 19.7 34.2 19.9"
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth="1"
      />
      <circle cx="30.4" cy="14.1" r="1" fill={stroke} />
      <circle cx="35" cy="18.6" r="0.62" fill={stroke} />
      <path
        d="M19.2 27 Q20.7 17.5 26.2 10.4"
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
