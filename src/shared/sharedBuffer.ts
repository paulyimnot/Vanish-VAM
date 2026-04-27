/**
 * SharedArrayBuffer Layout (Float64, 8 bytes each)
 * Shared between Thread A (Feed) and Thread B (Engine) — zero-copy
 *
 * BBO (Best Bid/Offer):
 *   [0] bidPrice   [1] bidQty   [2] askPrice  [3] askQty  [4] timestamp(ms)
 *
 * L2 Order Book (10 levels each):
 *   [5..14]  bidPrices   [15..24] bidQtys
 *   [25..34] askPrices   [35..44] askQtys
 *
 * Engine State (written by Thread B, read by Thread C):
 *   [45] atr           [46] vwap          [47] obi
 *   [48] signal        (0=flat, 1=long, -1=short)
 *   [49] signalPrice   [50] signalAtr     [51] regimeScore  [52] vwapPeriodVol
 */

export const DEPTH = 10;

export const BID_PRICE  = 0;
export const BID_QTY    = 1;
export const ASK_PRICE  = 2;
export const ASK_QTY    = 3;
export const TIMESTAMP  = 4;

export const BID_PRICES_START = 5;          // [5..14]
export const BID_QTYS_START   = 5 + DEPTH; // [15..24]
export const ASK_PRICES_START = 5 + DEPTH * 2; // [25..34]
export const ASK_QTYS_START   = 5 + DEPTH * 3; // [35..44]

export const ATR          = 5 + DEPTH * 4;   // [45]
export const VWAP         = ATR + 1;          // [46]
export const OBI          = ATR + 2;          // [47]
export const SIGNAL       = ATR + 3;          // [48]
export const SIGNAL_PRICE = ATR + 4;          // [49]
export const SIGNAL_ATR   = ATR + 5;          // [50]
export const REGIME_SCORE = ATR + 6;          // [51]
export const VWAP_VOL     = ATR + 7;          // [52] — rolling volume for VWAP

export const TOTAL_ELEMENTS = ATR + 8;        // 53 total Float64 elements
export const BUFFER_BYTES   = TOTAL_ELEMENTS * Float64Array.BYTES_PER_ELEMENT;
