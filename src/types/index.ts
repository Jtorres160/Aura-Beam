// ═══════════════════════════════════════════════════════════
// Aura — Shared TypeScript Types
// ═══════════════════════════════════════════════════════════

export type Game = "POKEMON" | "MTG" | "YUGIOH";
export type Rarity = "COMMON" | "UNCOMMON" | "RARE" | "ULTRA_RARE" | "SECRET_RARE" | "MYTHIC" | "SPECIAL";
export type Plan = "FREE" | "PRO";
export type UserRole = "USER" | "ADMIN";

// ─── Card ───────────────────────────────────────────────────

export interface CardBase {
  id: string;
  externalId?: string;
  name: string;
  game: Game;
  setName: string;
  setCode?: string;
  collectorNumber?: string;
  rarity: Rarity;
  imageUrl?: string;
  thumbnailUrl?: string;
}

export interface CardPrice {
  marketPrice?: number;
  lowPrice?: number;
  midPrice?: number;
  highPrice?: number;
  foilPrice?: number;
  currency: string;
  lastUpdated: string;
}

export interface CardWithPrice extends CardBase {
  prices?: CardPrice;
}

// ─── Scan ───────────────────────────────────────────────────

export interface ScanResult {
  card: CardWithPrice;
  confidence: number;
  matchMethod: "ocr" | "image" | "hybrid";
  processingTimeMs: number;
  alternatives?: Array<{
    card: CardBase;
    confidence: number;
  }>;
}

export interface ScanRequest {
  imageBase64: string;
  game?: Game; // optional hint
}

// ─── Collection ─────────────────────────────────────────────

export interface CollectionCard {
  id: string;
  card: CardWithPrice;
  quantity: number;
  condition?: string;
  notes?: string;
  addedAt: string;
}

export interface CollectionSummary {
  totalCards: number;
  totalValue: number;
  dailyChange: number;
  weeklyChange: number;
  monthlyChange: number;
  mostValuable: CardWithPrice;
  biggestGainer: CardWithPrice & { changePercent: number };
  biggestLoser: CardWithPrice & { changePercent: number };
}

// ─── Watchlist ──────────────────────────────────────────────

export interface WatchlistItem {
  id: string;
  card: CardWithPrice;
  alertAbove?: number;
  alertBelow?: number;
  alertEnabled: boolean;
}

// ─── Dashboard ──────────────────────────────────────────────

export interface DashboardData {
  collection: CollectionSummary;
  recentScans: Array<{
    card: CardBase;
    price: number;
    confidence: number;
    scannedAt: string;
  }>;
  priceMovers: Array<{
    card: CardBase;
    change: number;
    changePercent: number;
    trend: "up" | "down";
  }>;
  portfolioHistory: Array<{
    date: string;
    value: number;
  }>;
}

// ─── API Response ───────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
