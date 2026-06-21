/**
 * Chess engine - complete implementation with legal move generation,
 * game state management, and status detection.
 */

import type {
  PieceColor,
  PieceType,
  Piece,
  Square,
  Board,
  Move,
  CastlingRights,
  GameState,
  GameStatus,
  MoveRecord,
} from "./types";

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** Convert algebraic notation (e.g. "e4") to board coordinates [row, col] */
export function squareToCoords(square: Square): [number, number] {
  const file = square.charCodeAt(0) - 97; // 'a' = 0, 'h' = 7
  const rank = 8 - parseInt(square[1], 10); // '8' = 0, '1' = 7
  return [rank, file];
}

/** Convert board coordinates [row, col] to algebraic notation */
export function coordsToSquare(row: number, col: number): Square {
  const file = String.fromCharCode(97 + col); // 0 = 'a', 7 = 'h'
  const rank = (8 - row).toString(); // 0 = '8', 7 = '1'
  return file + rank;
}

/** Check if coordinates are within the 8x8 board */
function isInBounds(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

/** Get piece at a square */
export function getPiece(state: GameState, square: Square): Piece | null {
  const [row, col] = squareToCoords(square);
  return state.board[row][col];
}

/** Deep clone a board */
function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
}

/** Get the opposite color */
function oppositeColor(color: PieceColor): PieceColor {
  return color === "white" ? "black" : "white";
}

// =============================================================================
// BOARD INITIALIZATION
// =============================================================================

/** Create the standard starting position board */
function createInitialBoard(): Board {
  const board: Board = Array(8)
    .fill(null)
    .map(() => Array(8).fill(null));

  // Black pieces (row 0 = rank 8)
  const backRank: PieceType[] = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
  for (let col = 0; col < 8; col++) {
    board[0][col] = { color: "black", type: backRank[col] };
    board[1][col] = { color: "black", type: "pawn" };
    board[6][col] = { color: "white", type: "pawn" };
    board[7][col] = { color: "white", type: backRank[col] };
  }

  return board;
}

/** Create initial game state with standard starting position */
export function createInitialState(): GameState {
  return {
    board: createInitialBoard(),
    turn: "white",
    castlingRights: {
      whiteKingside: true,
      whiteQueenside: true,
      blackKingside: true,
      blackQueenside: true,
    },
    enPassantTarget: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    status: "playing",
    winner: null,
    moveHistory: [],
  };
}

// =============================================================================
// FEN PARSING AND SERIALIZATION
// =============================================================================

const PIECE_TO_FEN: Record<PieceType, string> = {
  pawn: "p",
  knight: "n",
  bishop: "b",
  rook: "r",
  queen: "q",
  king: "k",
};

const FEN_TO_PIECE: Record<string, PieceType> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

/** Convert game state to FEN notation */
export function toFEN(state: GameState): string {
  // 1. Piece placement
  const rows: string[] = [];
  for (let row = 0; row < 8; row++) {
    let rowStr = "";
    let emptyCount = 0;
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row][col];
      if (piece) {
        if (emptyCount > 0) {
          rowStr += emptyCount.toString();
          emptyCount = 0;
        }
        const letter = PIECE_TO_FEN[piece.type];
        rowStr += piece.color === "white" ? letter.toUpperCase() : letter;
      } else {
        emptyCount++;
      }
    }
    if (emptyCount > 0) {
      rowStr += emptyCount.toString();
    }
    rows.push(rowStr);
  }
  const placement = rows.join("/");

  // 2. Active color
  const activeColor = state.turn === "white" ? "w" : "b";

  // 3. Castling availability
  let castling = "";
  if (state.castlingRights.whiteKingside) castling += "K";
  if (state.castlingRights.whiteQueenside) castling += "Q";
  if (state.castlingRights.blackKingside) castling += "k";
  if (state.castlingRights.blackQueenside) castling += "q";
  if (!castling) castling = "-";

  // 4. En passant target
  const enPassant = state.enPassantTarget || "-";

  // 5. Halfmove clock
  const halfmove = state.halfmoveClock.toString();

  // 6. Fullmove number
  const fullmove = state.fullmoveNumber.toString();

  return `${placement} ${activeColor} ${castling} ${enPassant} ${halfmove} ${fullmove}`;
}

/** Parse FEN notation into game state */
export function fromFEN(fen: string): GameState {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    throw new Error("Invalid FEN: expected at least 4 parts");
  }

  const [placement, activeColor, castling, enPassant] = parts;
  const halfmove = parts.length > 4 ? parseInt(parts[4], 10) : 0;
  const fullmove = parts.length > 5 ? parseInt(parts[5], 10) : 1;

  // Parse piece placement
  const board: Board = Array(8)
    .fill(null)
    .map(() => Array(8).fill(null));

  const rows = placement.split("/");
  if (rows.length !== 8) {
    throw new Error("Invalid FEN: expected 8 rows");
  }

  for (let row = 0; row < 8; row++) {
    let col = 0;
    for (const char of rows[row]) {
      if (/[1-8]/.test(char)) {
        col += parseInt(char, 10);
      } else {
        const pieceType = FEN_TO_PIECE[char.toLowerCase()];
        if (!pieceType) {
          throw new Error(`Invalid FEN: unknown piece '${char}'`);
        }
        const color: PieceColor = char === char.toUpperCase() ? "white" : "black";
        board[row][col] = { color, type: pieceType };
        col++;
      }
    }
  }

  // Parse active color
  const turn: PieceColor = activeColor === "w" ? "white" : "black";

  // Parse castling rights
  const castlingRights: CastlingRights = {
    whiteKingside: castling.includes("K"),
    whiteQueenside: castling.includes("Q"),
    blackKingside: castling.includes("k"),
    blackQueenside: castling.includes("q"),
  };

  // Parse en passant
  const enPassantTarget: Square | null = enPassant === "-" ? null : enPassant;

  // Create state - status will be calculated later
  const state: GameState = {
    board,
    turn,
    castlingRights,
    enPassantTarget,
    halfmoveClock: halfmove,
    fullmoveNumber: fullmove,
    status: "playing",
    winner: null,
    moveHistory: [],
  };

  // Update status based on position
  state.status = getGameStatus(state);

  return state;
}

// Alias for compatibility
export const createInitialStateFromFen = fromFEN;

// =============================================================================
// ATTACK DETECTION
// =============================================================================

/** Check if a square is attacked by a specific color */
export function isSquareAttacked(
  board: Board,
  square: Square,
  byColor: PieceColor
): boolean {
  const [targetRow, targetCol] = squareToCoords(square);

  // Check all squares for pieces that can attack the target
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (!piece || piece.color !== byColor) continue;

      if (canPieceAttackSquare(board, piece, row, col, targetRow, targetCol)) {
        return true;
      }
    }
  }

  return false;
}

/** Check if a specific piece can attack a target square */
function canPieceAttackSquare(
  board: Board,
  piece: Piece,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number
): boolean {
  const dRow = toRow - fromRow;
  const dCol = toCol - fromCol;
  const absRow = Math.abs(dRow);
  const absCol = Math.abs(dCol);

  switch (piece.type) {
    case "pawn": {
      // Pawns attack diagonally
      const direction = piece.color === "white" ? -1 : 1;
      return dRow === direction && absCol === 1;
    }

    case "knight":
      return (absRow === 2 && absCol === 1) || (absRow === 1 && absCol === 2);

    case "bishop":
      if (absRow !== absCol || absRow === 0) return false;
      return isPathClear(board, fromRow, fromCol, toRow, toCol);

    case "rook":
      if (dRow !== 0 && dCol !== 0) return false;
      if (dRow === 0 && dCol === 0) return false;
      return isPathClear(board, fromRow, fromCol, toRow, toCol);

    case "queen":
      if (dRow !== 0 && dCol !== 0 && absRow !== absCol) return false;
      if (dRow === 0 && dCol === 0) return false;
      return isPathClear(board, fromRow, fromCol, toRow, toCol);

    case "king":
      return absRow <= 1 && absCol <= 1 && (absRow + absCol > 0);

    default:
      return false;
  }
}

/** Check if path between two squares is clear (for sliding pieces) */
function isPathClear(
  board: Board,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number
): boolean {
  const dRow = Math.sign(toRow - fromRow);
  const dCol = Math.sign(toCol - fromCol);

  let row = fromRow + dRow;
  let col = fromCol + dCol;

  while (row !== toRow || col !== toCol) {
    if (board[row][col]) return false;
    row += dRow;
    col += dCol;
  }

  return true;
}

/** Check if a color's king is in check */
export function isInCheck(state: GameState, color: PieceColor): boolean {
  // Find the king
  let kingSquare: Square | null = null;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row][col];
      if (piece && piece.type === "king" && piece.color === color) {
        kingSquare = coordsToSquare(row, col);
        break;
      }
    }
    if (kingSquare) break;
  }

  if (!kingSquare) return false; // No king found (shouldn't happen in valid game)

  return isSquareAttacked(state.board, kingSquare, oppositeColor(color));
}

// =============================================================================
// MOVE GENERATION
// =============================================================================

/** Generate all pseudo-legal moves for a color (doesn't check if king is left in check) */
function generatePseudoLegalMoves(state: GameState, color: PieceColor): Move[] {
  const moves: Move[] = [];

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row][col];
      if (!piece || piece.color !== color) continue;

      const square = coordsToSquare(row, col);
      const pieceMoves = generatePieceMoves(state, piece, row, col);
      moves.push(...pieceMoves.map((to) => ({ from: square, to })));
    }
  }

  // Add castling moves
  moves.push(...generateCastlingMoves(state, color));

  // Handle pawn promotions
  return expandPromotions(moves, state);
}

/** Generate moves for a specific piece (returns target squares) */
function generatePieceMoves(
  state: GameState,
  piece: Piece,
  row: number,
  col: number
): Square[] {
  switch (piece.type) {
    case "pawn":
      return generatePawnMoves(state, piece.color, row, col);
    case "knight":
      return generateKnightMoves(state.board, piece.color, row, col);
    case "bishop":
      return generateSlidingMoves(state.board, piece.color, row, col, [
        [-1, -1], [-1, 1], [1, -1], [1, 1],
      ]);
    case "rook":
      return generateSlidingMoves(state.board, piece.color, row, col, [
        [-1, 0], [1, 0], [0, -1], [0, 1],
      ]);
    case "queen":
      return generateSlidingMoves(state.board, piece.color, row, col, [
        [-1, -1], [-1, 1], [1, -1], [1, 1],
        [-1, 0], [1, 0], [0, -1], [0, 1],
      ]);
    case "king":
      return generateKingMoves(state.board, piece.color, row, col);
    default:
      return [];
  }
}

/** Generate pawn moves including captures, double push, and en passant */
function generatePawnMoves(
  state: GameState,
  color: PieceColor,
  row: number,
  col: number
): Square[] {
  const moves: Square[] = [];
  const direction = color === "white" ? -1 : 1;
  const startRow = color === "white" ? 6 : 1;

  // Single push
  const newRow = row + direction;
  if (isInBounds(newRow, col) && !state.board[newRow][col]) {
    moves.push(coordsToSquare(newRow, col));

    // Double push from starting position
    if (row === startRow) {
      const doubleRow = row + 2 * direction;
      if (!state.board[doubleRow][col]) {
        moves.push(coordsToSquare(doubleRow, col));
      }
    }
  }

  // Captures (including en passant)
  for (const dCol of [-1, 1]) {
    const captureCol = col + dCol;
    if (!isInBounds(newRow, captureCol)) continue;

    const targetPiece = state.board[newRow][captureCol];
    if (targetPiece && targetPiece.color !== color) {
      moves.push(coordsToSquare(newRow, captureCol));
    }

    // En passant
    const enPassantSquare = coordsToSquare(newRow, captureCol);
    if (state.enPassantTarget === enPassantSquare) {
      moves.push(enPassantSquare);
    }
  }

  return moves;
}

/** Generate knight moves */
function generateKnightMoves(
  board: Board,
  color: PieceColor,
  row: number,
  col: number
): Square[] {
  const moves: Square[] = [];
  const offsets = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ];

  for (const [dRow, dCol] of offsets) {
    const newRow = row + dRow;
    const newCol = col + dCol;
    if (!isInBounds(newRow, newCol)) continue;

    const targetPiece = board[newRow][newCol];
    if (!targetPiece || targetPiece.color !== color) {
      moves.push(coordsToSquare(newRow, newCol));
    }
  }

  return moves;
}

/** Generate moves for sliding pieces (bishop, rook, queen) */
function generateSlidingMoves(
  board: Board,
  color: PieceColor,
  row: number,
  col: number,
  directions: [number, number][]
): Square[] {
  const moves: Square[] = [];

  for (const [dRow, dCol] of directions) {
    let newRow = row + dRow;
    let newCol = col + dCol;

    while (isInBounds(newRow, newCol)) {
      const targetPiece = board[newRow][newCol];
      if (!targetPiece) {
        moves.push(coordsToSquare(newRow, newCol));
      } else {
        if (targetPiece.color !== color) {
          moves.push(coordsToSquare(newRow, newCol));
        }
        break;
      }
      newRow += dRow;
      newCol += dCol;
    }
  }

  return moves;
}

/** Generate king moves (excluding castling, which is handled separately) */
function generateKingMoves(
  board: Board,
  color: PieceColor,
  row: number,
  col: number
): Square[] {
  const moves: Square[] = [];
  const offsets = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];

  for (const [dRow, dCol] of offsets) {
    const newRow = row + dRow;
    const newCol = col + dCol;
    if (!isInBounds(newRow, newCol)) continue;

    const targetPiece = board[newRow][newCol];
    if (!targetPiece || targetPiece.color !== color) {
      moves.push(coordsToSquare(newRow, newCol));
    }
  }

  return moves;
}

/** Generate castling moves */
function generateCastlingMoves(state: GameState, color: PieceColor): Move[] {
  const moves: Move[] = [];
  const row = color === "white" ? 7 : 0;
  const kingCol = 4;

  // Can't castle if in check
  if (isInCheck(state, color)) return moves;

  // Kingside castling
  const canKingside =
    color === "white"
      ? state.castlingRights.whiteKingside
      : state.castlingRights.blackKingside;

  if (canKingside) {
    // Check if squares between king and rook are empty
    if (!state.board[row][5] && !state.board[row][6]) {
      // Check that king doesn't pass through or land on attacked square
      const kingSquare = coordsToSquare(row, kingCol);
      const passSquare = coordsToSquare(row, 5);
      const destSquare = coordsToSquare(row, 6);
      const enemy = oppositeColor(color);

      if (
        !isSquareAttacked(state.board, passSquare, enemy) &&
        !isSquareAttacked(state.board, destSquare, enemy)
      ) {
        moves.push({ from: kingSquare, to: destSquare });
      }
    }
  }

  // Queenside castling
  const canQueenside =
    color === "white"
      ? state.castlingRights.whiteQueenside
      : state.castlingRights.blackQueenside;

  if (canQueenside) {
    // Check if squares between king and rook are empty
    if (!state.board[row][1] && !state.board[row][2] && !state.board[row][3]) {
      // Check that king doesn't pass through or land on attacked square
      const kingSquare = coordsToSquare(row, kingCol);
      const passSquare = coordsToSquare(row, 3);
      const destSquare = coordsToSquare(row, 2);
      const enemy = oppositeColor(color);

      if (
        !isSquareAttacked(state.board, passSquare, enemy) &&
        !isSquareAttacked(state.board, destSquare, enemy)
      ) {
        moves.push({ from: kingSquare, to: destSquare });
      }
    }
  }

  return moves;
}

/** Expand pawn moves to promotion rank into 4 separate moves (Q, R, B, N) */
function expandPromotions(moves: Move[], state: GameState): Move[] {
  const expanded: Move[] = [];

  for (const move of moves) {
    const [fromRow] = squareToCoords(move.from);
    const [toRow] = squareToCoords(move.to);
    const piece = state.board[fromRow][squareToCoords(move.from)[1]];

    // Check if this is a pawn reaching the last rank
    const isPromotion =
      piece?.type === "pawn" &&
      ((piece.color === "white" && toRow === 0) ||
        (piece.color === "black" && toRow === 7));

    if (isPromotion) {
      const promotionPieces: PieceType[] = ["queen", "rook", "bishop", "knight"];
      for (const promotion of promotionPieces) {
        expanded.push({ ...move, promotion });
      }
    } else {
      expanded.push(move);
    }
  }

  return expanded;
}

/** Generate all legal moves for a color (filters out moves that leave king in check) */
export function generateLegalMoves(state: GameState, color: PieceColor): Move[] {
  const pseudoLegal = generatePseudoLegalMoves(state, color);
  return pseudoLegal.filter((move) => {
    // Make the move on a temporary state and check if king is in check
    const testState = applyMoveToBoard(state, move);
    return !isInCheck(testState, color);
  });
}

/** Generate legal moves from a specific square (for UI highlighting) */
export function generateLegalMovesFromSquare(state: GameState, square: Square): Move[] {
  const [row, col] = squareToCoords(square);
  const piece = state.board[row][col];
  if (!piece || piece.color !== state.turn) return [];

  const allLegal = generateLegalMoves(state, state.turn);
  return allLegal.filter((move) => move.from === square);
}

// Alias for compatibility
export const getLegalMovesForSquare = generateLegalMovesFromSquare;

/** Check if a move is legal */
export function isLegalMove(state: GameState, move: Move): boolean {
  const legalMoves = generateLegalMoves(state, state.turn);
  return legalMoves.some(
    (m) =>
      m.from === move.from &&
      m.to === move.to &&
      m.promotion === move.promotion
  );
}

// Alias for compatibility
export const isMoveLegal = isLegalMove;

// =============================================================================
// GAME STATUS DETECTION
// =============================================================================

/** Determine game status based on current position */
export function getGameStatus(state: GameState): GameStatus {
  if (state.status === "paused") return "paused";

  const legalMoves = generateLegalMoves(state, state.turn);
  const inCheck = isInCheck(state, state.turn);

  // No legal moves
  if (legalMoves.length === 0) {
    if (inCheck) {
      return "checkmate";
    }
    return "stalemate";
  }

  // Check for draws
  if (isInsufficientMaterial(state.board)) {
    return "draw";
  }

  // 50-move rule
  if (state.halfmoveClock >= 100) {
    return "draw";
  }

  // Threefold repetition
  if (isThreefoldRepetition(state)) {
    return "draw";
  }

  // In check but has moves
  if (inCheck) {
    return "check";
  }

  return "playing";
}

/** Check for checkmate */
export function isCheckmate(state: GameState): boolean {
  return getGameStatus(state) === "checkmate";
}

/** Check for stalemate */
export function isStalemate(state: GameState): boolean {
  return getGameStatus(state) === "stalemate";
}

/** Check for insufficient material to deliver checkmate */
export function isInsufficientMaterial(board: Board): boolean {
  const pieces: { color: PieceColor; type: PieceType; square: Square }[] = [];

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece) {
        pieces.push({
          color: piece.color,
          type: piece.type,
          square: coordsToSquare(row, col),
        });
      }
    }
  }

  // King vs King
  if (pieces.length === 2) {
    return true;
  }

  // King + minor piece vs King
  if (pieces.length === 3) {
    const nonKings = pieces.filter((p) => p.type !== "king");
    if (nonKings.length === 1) {
      const piece = nonKings[0];
      if (piece.type === "bishop" || piece.type === "knight") {
        return true;
      }
    }
  }

  // King + Bishop vs King + Bishop (same color bishops)
  if (pieces.length === 4) {
    const bishops = pieces.filter((p) => p.type === "bishop");
    if (bishops.length === 2 && bishops[0].color !== bishops[1].color) {
      // Check if bishops are on same color squares
      const [r1, c1] = squareToCoords(bishops[0].square);
      const [r2, c2] = squareToCoords(bishops[1].square);
      const bishop1Dark = (r1 + c1) % 2 === 0;
      const bishop2Dark = (r2 + c2) % 2 === 0;
      if (bishop1Dark === bishop2Dark) {
        return true;
      }
    }
  }

  return false;
}

/** Check for threefold repetition using FEN position history */
function isThreefoldRepetition(state: GameState): boolean {
  if (state.moveHistory.length < 8) return false;

  // Get position part of FEN (without move counters)
  const currentFEN = toFEN(state);
  const positionPart = currentFEN.split(" ").slice(0, 4).join(" ");

  let count = 1; // Current position counts as 1

  // Check history for matching positions
  for (const record of state.moveHistory) {
    const historyPosition = record.fenAfter.split(" ").slice(0, 4).join(" ");
    if (historyPosition === positionPart) {
      count++;
      if (count >= 3) return true;
    }
  }

  return false;
}

// =============================================================================
// MOVE EXECUTION
// =============================================================================

/** Apply a move to the board and return new state (without updating game metadata) */
function applyMoveToBoard(state: GameState, move: Move): GameState {
  const newBoard = cloneBoard(state.board);
  const [fromRow, fromCol] = squareToCoords(move.from);
  const [toRow, toCol] = squareToCoords(move.to);
  const piece = newBoard[fromRow][fromCol];

  if (!piece) {
    return { ...state, board: newBoard };
  }

  // Move the piece
  newBoard[toRow][toCol] = move.promotion
    ? { color: piece.color, type: move.promotion }
    : piece;
  newBoard[fromRow][fromCol] = null;

  // Handle en passant capture
  if (piece.type === "pawn" && move.to === state.enPassantTarget) {
    const captureRow = piece.color === "white" ? toRow + 1 : toRow - 1;
    newBoard[captureRow][toCol] = null;
  }

  // Handle castling - move the rook
  if (piece.type === "king") {
    const colDiff = toCol - fromCol;
    if (Math.abs(colDiff) === 2) {
      // Kingside castling
      if (colDiff > 0) {
        newBoard[fromRow][5] = newBoard[fromRow][7];
        newBoard[fromRow][7] = null;
      }
      // Queenside castling
      else {
        newBoard[fromRow][3] = newBoard[fromRow][0];
        newBoard[fromRow][0] = null;
      }
    }
  }

  return { ...state, board: newBoard };
}

/** Make a move and return a new game state (immutable) */
export function makeMove(state: GameState, move: Move): GameState {
  if (!isLegalMove(state, move)) {
    throw new Error(`Illegal move: ${move.from} to ${move.to}`);
  }

  const [fromRow, fromCol] = squareToCoords(move.from);
  const [toRow, toCol] = squareToCoords(move.to);
  const piece = state.board[fromRow][fromCol]!;
  const capturedPiece = state.board[toRow][toCol];

  // Generate SAN before making the move
  const san = toSAN(state, move);
  const fenBefore = toFEN(state);

  // Apply the move to the board
  const afterBoard = applyMoveToBoard(state, move);
  const newBoard = afterBoard.board;

  // Update castling rights
  const newCastlingRights = { ...state.castlingRights };

  // King moves remove both castling rights
  if (piece.type === "king") {
    if (piece.color === "white") {
      newCastlingRights.whiteKingside = false;
      newCastlingRights.whiteQueenside = false;
    } else {
      newCastlingRights.blackKingside = false;
      newCastlingRights.blackQueenside = false;
    }
  }

  // Rook moves or captures remove specific castling rights
  if (piece.type === "rook") {
    if (move.from === "a1") newCastlingRights.whiteQueenside = false;
    if (move.from === "h1") newCastlingRights.whiteKingside = false;
    if (move.from === "a8") newCastlingRights.blackQueenside = false;
    if (move.from === "h8") newCastlingRights.blackKingside = false;
  }

  // Rook captured also removes castling rights
  if (move.to === "a1") newCastlingRights.whiteQueenside = false;
  if (move.to === "h1") newCastlingRights.whiteKingside = false;
  if (move.to === "a8") newCastlingRights.blackQueenside = false;
  if (move.to === "h8") newCastlingRights.blackKingside = false;

  // Update en passant target
  let newEnPassant: Square | null = null;
  if (piece.type === "pawn" && Math.abs(toRow - fromRow) === 2) {
    // Pawn double push - set en passant square
    const epRow = (fromRow + toRow) / 2;
    newEnPassant = coordsToSquare(epRow, fromCol);
  }

  // Update halfmove clock (reset on pawn move or capture)
  const isCapture = capturedPiece !== null || (piece.type === "pawn" && move.to === state.enPassantTarget);
  const newHalfmoveClock = piece.type === "pawn" || isCapture ? 0 : state.halfmoveClock + 1;

  // Update fullmove number (increments after black's move)
  const newFullmoveNumber =
    state.turn === "black" ? state.fullmoveNumber + 1 : state.fullmoveNumber;

  // Create intermediate state to calculate status
  const intermediateState: GameState = {
    board: newBoard,
    turn: oppositeColor(state.turn),
    castlingRights: newCastlingRights,
    enPassantTarget: newEnPassant,
    halfmoveClock: newHalfmoveClock,
    fullmoveNumber: newFullmoveNumber,
    status: "playing",
    winner: null,
    moveHistory: state.moveHistory,
  };

  const fenAfter = toFEN(intermediateState);

  // Create move record
  const moveRecord: MoveRecord = {
    move,
    san,
    fenBefore,
    fenAfter,
    timestamp: Date.now(),
  };

  // Determine new status and winner
  const newStatus = getGameStatus(intermediateState);
  let winner: PieceColor | null = null;
  if (newStatus === "checkmate") {
    winner = state.turn; // The player who just moved wins
  }

  return {
    ...intermediateState,
    status: newStatus,
    winner,
    moveHistory: [...state.moveHistory, moveRecord],
  };
}

// =============================================================================
// STANDARD ALGEBRAIC NOTATION (SAN)
// =============================================================================

/** Convert a move to Standard Algebraic Notation */
export function toSAN(state: GameState, move: Move): string {
  const [fromRow, fromCol] = squareToCoords(move.from);
  const [toRow, toCol] = squareToCoords(move.to);
  const piece = state.board[fromRow][fromCol];

  if (!piece) return move.from + move.to;

  // Castling
  if (piece.type === "king" && Math.abs(toCol - fromCol) === 2) {
    return toCol > fromCol ? "O-O" : "O-O-O";
  }

  let san = "";

  // Piece letter (uppercase, no letter for pawns)
  if (piece.type !== "pawn") {
    const pieceLetters: Record<PieceType, string> = {
      pawn: "",
      knight: "N",
      bishop: "B",
      rook: "R",
      queen: "Q",
      king: "K",
    };
    san += pieceLetters[piece.type];
  }

  // Disambiguation for non-pawn pieces
  if (piece.type !== "pawn" && piece.type !== "king") {
    const otherPieces = findOtherPiecesThatCanReachSquare(
      state,
      piece.type,
      piece.color,
      move.to,
      move.from
    );

    if (otherPieces.length > 0) {
      const sameFile = otherPieces.some(
        (sq) => squareToCoords(sq)[1] === fromCol
      );
      const sameRank = otherPieces.some(
        (sq) => squareToCoords(sq)[0] === fromRow
      );

      if (!sameFile) {
        // File is sufficient
        san += move.from[0];
      } else if (!sameRank) {
        // Rank is sufficient
        san += move.from[1];
      } else {
        // Need both
        san += move.from;
      }
    }
  }

  // Capture
  const isCapture =
    state.board[toRow][toCol] !== null ||
    (piece.type === "pawn" && move.to === state.enPassantTarget);

  if (isCapture) {
    if (piece.type === "pawn") {
      san += move.from[0]; // File letter for pawn captures
    }
    san += "x";
  }

  // Destination square
  san += move.to;

  // Promotion
  if (move.promotion) {
    const promotionLetters: Record<PieceType, string> = {
      pawn: "",
      knight: "N",
      bishop: "B",
      rook: "R",
      queen: "Q",
      king: "K",
    };
    san += "=" + promotionLetters[move.promotion];
  }

  // Check or checkmate suffix
  const testState = applyMoveToBoard(state, move);
  const newState: GameState = {
    ...testState,
    turn: oppositeColor(state.turn),
    castlingRights: state.castlingRights,
    enPassantTarget: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    status: "playing",
    winner: null,
    moveHistory: [],
  };

  if (isInCheck(newState, newState.turn)) {
    const legalMoves = generateLegalMoves(newState, newState.turn);
    if (legalMoves.length === 0) {
      san += "#"; // Checkmate
    } else {
      san += "+"; // Check
    }
  }

  return san;
}

/** Find other pieces of the same type that can reach the same square */
function findOtherPiecesThatCanReachSquare(
  state: GameState,
  pieceType: PieceType,
  color: PieceColor,
  targetSquare: Square,
  excludeSquare: Square
): Square[] {
  const result: Square[] = [];

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = coordsToSquare(row, col);
      if (square === excludeSquare) continue;

      const piece = state.board[row][col];
      if (!piece || piece.type !== pieceType || piece.color !== color) continue;

      // Check if this piece can legally reach the target square
      const moves = generateLegalMovesFromSquare(state, square);
      if (moves.some((m) => m.to === targetSquare)) {
        result.push(square);
      }
    }
  }

  return result;
}

// =============================================================================
// ASCII BOARD REPRESENTATION (for LLM prompts)
// =============================================================================

/** Convert board to ASCII representation for LLM prompts */
export function boardToAscii(state: GameState): string {
  const rows: string[] = [];

  for (let row = 0; row < 8; row++) {
    const squares: string[] = [];
    for (let col = 0; col < 8; col++) {
      const piece = state.board[row][col];
      if (!piece) {
        squares.push(".");
      } else {
        const letter = PIECE_TO_FEN[piece.type];
        squares.push(piece.color === "white" ? letter.toUpperCase() : letter);
      }
    }
    rows.push(squares.join(" "));
  }

  return rows.join(" / ");
}
