// Voice → Move helper utilities extracted from main.js
// These helpers are pure or near-pure and accept the current FEN and Chess.js ctor.

// Convert SAN or UCI into a spoken phrase, using FEN to resolve UCI to SAN when possible
export function humanizeMoveFromFen(fen, moveText, ChessCtor) {
  if (!moveText) return '';

  const normalizeSan = (san) => {
    if (!san) return '';
    let s = san.trim();
    s = s.replace(/[+#?!]+$/g, '');

    if (/^O-O-O/i.test(s)) return 'castle queen side';
    if (/^O-O/i.test(s)) return 'castle king side';

    const matchSquares = Array.from(s.matchAll(/([a-h][1-8])/gi));
    const dest = matchSquares.length ? matchSquares[matchSquares.length - 1][1].toLowerCase() : s.toLowerCase();

    const promoMatch = s.match(/=([QRBN])/i);
    if (promoMatch) {
      const promoNames = { Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
      const piece = promoNames[promoMatch[1].toUpperCase()] || promoMatch[1].toLowerCase();
      return `${dest} promotes to ${piece}`;
    }

    const isCapture = s.includes('x');
    const pieceNames = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight' };
    const prefix = s[0] ? s[0].toUpperCase() : '';

    if (pieceNames[prefix]) {
      const name = pieceNames[prefix];
      return isCapture ? `${name} takes ${dest}` : `${name} ${dest}`;
    }

    // Pawn moves: on capture use file letter (e.g., 'exd5' -> 'e takes d5')
    if (isCapture) {
      const m = s.match(/^([a-h])x/i);
      if (m) {
        return `${m[1].toLowerCase()} takes ${dest}`;
      }
      return `pawn takes ${dest}`;
    }
    return dest;
  };

  if (!fen || !ChessCtor) return normalizeSan(moveText);

  const temp = new ChessCtor(fen);

  // Try UCI first
  const uciMatch = moveText.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
  if (uciMatch) {
    const [, from, to, promo] = uciMatch;
    const mv = temp.move({ from: from.toLowerCase(), to: to.toLowerCase(), promotion: promo ? promo.toLowerCase() : undefined });
    if (mv && mv.san) return normalizeSan(mv.san);
  }

  // Try SAN/lan via sloppy parsing
  try {
    const clone = new ChessCtor(fen);
    const mv = clone.move(moveText, { sloppy: true });
    if (mv && mv.san) return normalizeSan(mv.san);
  } catch (_) {
    // fall back to raw normalization
  }

  return normalizeSan(moveText);
}

// Resolve implicit destination like 'xe5' or 'pawn to a4' to a unique UCI if possible
export function resolveImplicitDestination(fen, moveText, ChessCtor) {
  try {
    if (!fen || !ChessCtor) return null;
    const game = new ChessCtor(fen);
    const s = String(moveText || '').toLowerCase().replace(/\s+/g, '');
    const mDest = s.match(/([a-h][1-8])$/);
    if (!mDest) return null;
    const dest = mDest[1];
    const wantsCapture = /x/.test(s);
    const wantsPawn = /\bpawn\b/.test(String(moveText).toLowerCase());
    const moves = game.moves({ verbose: true });
    let pool = moves.filter(m => m.to === dest);
    if (wantsCapture) pool = pool.filter(m => m.flags && m.flags.includes('c'));
    if (wantsPawn || !/^[nbrqk]/i.test(s)) pool = pool.filter(m => m.piece === 'p');
    if (pool.length === 1) {
      const mv = pool[0];
      const uci = mv.from + mv.to + (mv.promotion || '');
      return uci;
    }
  } catch {}
  return null;
}

// Convert a typed move to UCI using FEN context (coordinate or SAN)
export function parseMoveToUCI(fen, moveText, ChessCtor) {
  const text = (moveText || '').trim();
  if (!text) return null;
  if (!fen || !ChessCtor) return null;

  // Coordinate format like e2e4 or e7e8q
  const coord = text.toLowerCase().replace(/\s+/g, '');
  const m = coord.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  if (m) {
    const from = m[1];
    const to = m[2];
    const promo = m[3] || '';
    const tmp = new ChessCtor(fen);
    const ok = tmp.move({ from, to, promotion: promo || undefined });
    if (!ok) return null;
    return from + to + promo;
  }

  // Else try SAN via chess.js with sloppy parsing
  try {
    const tmp = new ChessCtor(fen);
    const mv = tmp.move(text, { sloppy: true });
    if (mv) {
      const promo = mv.promotion ? mv.promotion : '';
      return mv.from + mv.to + promo;
    }
  } catch (_) {
    // ignore and try fallback below
  }
  // Fallback resolution (e.g., 'xe5', 'pawn to a4')
  const uci = resolveImplicitDestination(fen, text, ChessCtor);
  return uci || null;
}

// String normalization for similarity
export function normalizeForSimilarity(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  // strip punctuation and diacritics
  t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[+#!?.,;:()\[\]{}"'`]/g, ' ');
  // number words -> digits
  const num = {
    'zero':'0','oh':'0','owe':'0','one':'1','won':'1','two':'2','too':'2','to':'2','three':'3','tree':'3','four':'4','for':'4','fore':'4','five':'5','six':'6','seven':'7','eight':'8','ate':'8','ait':'8'
  };
  t = t.split(/\s+/).map(w => num[w] || w).join(' ');
  // drop fillers
  const fillers = new Set(['to','into','towards','toward','on','and','then','than','the','a','an','move','my','your','their','this','that','with','from','at','is','was','are','please','just']);
  t = t.split(/\s+/).filter(w => w && !fillers.has(w)).join(' ');
  // normalize castles
  t = t.replace(/o\s*-\s*o\s*-\s*o/g, 'o-o-o').replace(/o\s*-\s*o/g, 'o-o');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Levenshtein similarity in [0,1]
export function computeSimilarity(a, b) {
  const aa = normalizeForSimilarity(a);
  const bb = normalizeForSimilarity(b);
  if (!aa && !bb) return 1;
  if (!aa || !bb) return 0;
  const nx = aa.length, ny = bb.length;
  const dp = new Array(ny + 1);
  for (let j = 0; j <= ny; j++) dp[j] = j;
  for (let i = 1; i <= nx; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= ny; j++) {
      const tmp = dp[j];
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  const dist = dp[ny];
  const maxLen = Math.max(nx, ny);
  return 1 - (dist / maxLen);
}

// Suggest the best matching legal move by similarity
export function findBestMatchingMoveSuggestion(fen, transcript, ChessCtor) {
  try {
    if (!fen || !ChessCtor) return null;
    const game = new ChessCtor(fen);
    const moves = game.moves({ verbose: true });
    if (!Array.isArray(moves) || !moves.length) return null;
    let best = null;
    const t = String(transcript || '');
    for (const mv of moves) {
      const san = mv.san || '';
      const uci = mv.from + mv.to + (mv.promotion || '');
      const spoken = humanizeMoveFromFen(fen, san, ChessCtor) || humanizeMoveFromFen(fen, uci, ChessCtor) || san || uci;
      const s1 = computeSimilarity(t, spoken);
      const s2 = computeSimilarity(t, san);
      const s3 = computeSimilarity(t, uci);
      const score = Math.max(s1, s2, s3);
      if (!best || score > best.score) {
        best = { uci, san, spoken, score };
      }
    }
    return best;
  } catch (e) {
    console.warn('Suggestion search failed:', e);
    return null;
  }
}

// Decide yes/no/unknown from transcript tokens
export function decideYesNo(transcript) {
  const raw = String(transcript || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const cleaned = raw.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned ? cleaned.split(' ') : [];
  const yesSet = new Set(['y','yes','yeah','yep','yup','correct','right','ok','okay','sure','affirmative','si']);
  const noSet = new Set(['n','no','nope','negative','incorrect','wrong','nah']);
  let decision = null;
  for (const tok of tokens) {
    if (noSet.has(tok)) decision = 'no';
    else if (yesSet.has(tok)) decision = 'yes';
  }
  return decision; // 'yes' | 'no' | null
}

