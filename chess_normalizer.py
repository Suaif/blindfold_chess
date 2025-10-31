"""
Chess speech normalization utilities.

The goal is to turn slightly messy speech-to-text output such as
"night f six takes eater" into a list of plausible chess move strings
(`["Nf6", "nf6", "g8f6"]`, ...).  The logic is intentionally rule-based
and deterministic so we can unit test and tweak it as new edge-cases
are reported.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


@dataclass
class NormalizationResult:
    """Structured information produced by the normalizer."""

    raw_text: str
    cleaned_text: str
    tokens: List[str]
    merged_tokens: List[str]
    candidates: List[str]
    direct_candidates: List[str] = field(default_factory=list)
    applied_rules: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        return {
            "raw_text": self.raw_text,
            "cleaned_text": self.cleaned_text,
            "tokens": self.tokens,
            "merged_tokens": self.merged_tokens,
            "candidates": self.candidates,
            "direct_candidates": self.direct_candidates,
            "applied_rules": self.applied_rules,
        }


# --- Dictionaries & helper constants ---------------------------------------

NUMBER_WORDS: Dict[str, str] = {
    "zero": "0",
    "oh": "0",
    "owe": "0",
    "one": "1",
    "won": "1",
    "two": "2",
    "too": "2",
    "to": "2",
    "tu": "2",
    "three": "3",
    "tree": "3",
    "free": "3",
    "four": "4",
    "for": "4",
    "fore": "4",
    "five": "5",
    "fife": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "ate": "8",
    "ait": "8",
}

LETTER_WORDS: Dict[str, str] = {
    "a": "a",
    "ay": "a",
    "hey": "a",
    "b": "b",
    "bee": "b",
    "be": "b",
    "c": "c",
    "cee": "c",
    "see": "c",
    "sea": "c",
    "d": "d",
    "dee": "d",
    "e": "e",
    "ee": "e",
    "eee": "e",
    "f": "f",
    "ef": "f",
    "eff": "f",
    "g": "g",
    "gee": "g",
    "jee": "g",
    "h": "h",
    "aitch": "h",
    "etch": "h",
    "edge": "h",
}

PIECE_WORDS: Dict[str, str] = {
    "pawn": "",
    "prawn": "",
    "knight": "N",
    "night": "N",
    "nite": "N",
    "k night": "N",
    "bishop": "B",
    "biship": "B",
    "beshop": "B",
    "bshop": "B",
    "rook": "R",
    "rock": "R",
    "ruke": "R",
    "queen": "Q",
    "quin": "Q",
    "king": "K",
    "keying": "K",
}

ACTION_WORDS: Dict[str, str] = {
    "take": "x",
    "takes": "x",
    "taking": "x",
    "takesu": "x",
    "capture": "x",
    "captures": "x",
    "captured": "x",
    "capturing": "x",
    "by": "x",
    "x": "x",
    "ex": "x",
}

CHECK_WORDS: Dict[str, str] = {
    "check": "+",
    "plus": "+",
    "checkmate": "#",
    "mate": "#",
    "hashtag": "#",
    "pound": "#",
}

PROMOTION_PIECES: Dict[str, str] = {
    "queen": "Q",
    "q": "Q",
    "rook": "R",
    "r": "R",
    "bishop": "B",
    "b": "B",
    "knight": "N",
    "night": "N",
    "n": "N",
}

PROMOTION_CUES = {"promote", "promotion", "promotes", "promoted", "equals", "equal", "equals", "=", "becomes"}
FILLER_WORDS = {
    "to",
    "into",
    "towards",
    "toward",
    "on",
    "and",
    "then",
    "than",
    "the",
    "a",
    "an",
    "move",
    "my",
    "your",
    "their",
    "this",
    "that",
    "with",
    "from",
    "at",
    "is",
    "was",
    "are",
    "please",
    "just",
}

SHOP_VARIANTS = {"shop", "shup", "sharp", "shock", "soup", "sop", "sub"}
SIDE_VARIANTS = {"side", "sigh", "sign"}


# --- Normalization helpers -------------------------------------------------

SAN_MOVE_PATTERN = re.compile(
    r"^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8](?:=[QRBN])?[+#]?)$",
    re.IGNORECASE,
)
CASTLE_SAN_PATTERN = re.compile(
    r"^(?:[O0](?:-?[O0])(?:-?[O0])?)(?:[+#])?$",
    re.IGNORECASE,
)
UCI_MOVE_PATTERN = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$", re.IGNORECASE)

CASTLING_PATTERNS: Sequence[Tuple[str, str, str]] = (
    (r"\bcastle\s+(king|short)\s*(side)?\b", "o o", "castle king-side"),
    (r"\bcastle\s+(queen|long)\s*(side)?\b", "o o o", "castle queen-side"),
    (r"\bking\s+castle\b", "o o", "king castle"),
    (r"\bqueen\s+castle\b", "o o o", "queen castle"),
    (r"\bshort\s+castle\b", "o o", "short castle"),
    (r"\blong\s+castle\b", "o o o", "long castle"),
    (r"\bo\s*-\s*o\s*-\s*o\b", "o o o", "spoken o-o-o"),
    (r"\bo\s*-\s*o\b", "o o", "spoken o-o"),
    (r"\b(?:oh|zero)\s+o\s+o\b", "o o", "spoken oh o o"),
    (r"\b(?:oh|zero)\s+o\s+o\s+o\b", "o o o", "spoken oh o o o"),
    (r"\bcastle\b", "o o", "castle alone"),
)

MULTIWORD_REPLACEMENTS: Sequence[Tuple[str, str, str]] = (
    (r"\bb\s*-\s*shop\b", "bishop", "b-shop -> bishop"),
    (r"\bbe\s*shop\b", "bishop", "be shop -> bishop"),
    (r"\bbee\s*shop\b", "bishop", "bee shop -> bishop"),
    (r"\bb\s+sharp\b", "bishop", "b sharp -> bishop"),
    (r"\bbsop\b", "bishop", "bsop -> bishop"),
    (r"\bb\s+soup\b", "bishop", "b soup -> bishop"),
    (r"\bb\s+sub\b", "bishop", "b sub -> bishop"),
    (r"\beshop\b", "bishop", "eshop -> bishop"),
    (r"\bknite\b", "knight", "knite -> knight"),
    (r"\bnite\b", "knight", "nite -> knight"),
    (r"\bnight\b", "knight", "night -> knight"),
    (r"\brock\b", "rook", "rock -> rook"),
    (r"\bquin\b", "queen", "quin -> queen"),
)


SQUARE_REGEX = re.compile(r"^[a-h][1-8]$", re.IGNORECASE)
PIECE_REGEX = re.compile(r"^[nbrqk]$")


def _apply_replacements(text: str, replacements: Sequence[Tuple[str, str, str]], applied_rules: List[str]) -> str:
    """Apply regex replacements while recording which rule matched."""
    for pattern, replacement, rule_name in replacements:
        new_text, count = re.subn(pattern, replacement, text)
        if count:
            applied_rules.append(rule_name)
            text = new_text
    return text


def _tokenize(text: str) -> List[str]:
    # Keep +, # and = as standalone tokens; everything else becomes alphanumeric.
    tokens = re.findall(r"[a-z0-9]+|[+#=]|O-O-O|O-O", text, flags=re.IGNORECASE)
    return [t.lower() for t in tokens if t.strip()]


def _combine_letter_digit_tokens(tokens: Sequence[str]) -> List[str]:
    merged: List[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in ("", " "):
            i += 1
            continue
        if token == "o-o" or token == "o-o-o":
            merged.append(token.upper())
            i += 1
            continue
        if token in {"o", "0"} and i + 2 < len(tokens) and tokens[i + 1] == "o" and tokens[i + 2] == "o":
            merged.append("O-O-O")
            i += 3
            continue

        if token in {"o", "0"} and i + 1 < len(tokens) and tokens[i + 1] == "o":
            merged.append("O-O")
            i += 2
            continue

        if token in LETTER_WORDS.values() and i + 1 < len(tokens) and tokens[i + 1] in NUMBER_WORDS.values():
            merged.append(token + tokens[i + 1])
            i += 2
            continue
        merged.append(token)
        i += 1
    return merged


def _merge_square_tokens(tokens: Sequence[str]) -> List[str]:
    """Second pass to merge tokens like ['n', 'f', '6'] -> ['n', 'f6']."""
    merged: List[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if PIECE_REGEX.match(token):
            merged.append(token.upper())
            i += 1
            continue

        if token in LETTER_WORDS.values() and i + 1 < len(tokens) and tokens[i + 1] in "12345678":
            merged.append(token + tokens[i + 1])
            i += 2
            continue
        merged.append(token)
        i += 1
    return merged


def _generate_direct_candidates(raw_text: str, applied_rules: List[str]) -> List[str]:
    if not raw_text:
        return []

    compact = re.sub(r"\s+", "", raw_text.strip())
    if not compact:
        return []
    compact = compact.replace("–", "-").replace("—", "-").replace("−", "-")

    candidates: List[str] = []

    def add(value: str) -> None:
        val = value.strip()
        if val and val not in candidates:
            candidates.append(val)

    matched_direct = False

    if CASTLE_SAN_PATTERN.match(compact):
        normalized = compact.upper().replace("0", "O")
        if "-" not in normalized:
            if len(normalized) == 2:
                normalized = "O-O"
            elif len(normalized) == 3:
                normalized = "O-O-O"
        add(normalized)
        matched_direct = True
        applied_rules.append(f"direct castle candidate '{normalized}'")

    if not matched_direct and SAN_MOVE_PATTERN.match(compact):
        add(compact)
        if compact and compact[0] in "kqrbn":
            add(compact[0].upper() + compact[1:])
        matched_direct = True
        applied_rules.append(f"direct SAN candidate '{compact}'")

    if UCI_MOVE_PATTERN.match(compact):
        lower_uci = compact.lower()
        add(lower_uci)
        matched_direct = True
        applied_rules.append(f"direct UCI candidate '{lower_uci}'")

    if matched_direct and len(candidates) > 1:
        # Preserve uniqueness while keeping original order
        uniq: List[str] = []
        for cand in candidates:
            if cand not in uniq:
                uniq.append(cand)
        candidates = uniq

    return candidates


def _map_tokens(tokens: Sequence[str], applied_rules: List[str]) -> List[str]:
    mapped: List[str] = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        next_token = tokens[i + 1] if i + 1 < len(tokens) else None

        if token in FILLER_WORDS:
            applied_rules.append(f"removed filler '{token}'")
            i += 1
            continue

        if token in PROMOTION_CUES:
            promotion_piece = None
            j = i + 1
            while j < len(tokens):
                candidate = tokens[j]
                if candidate in FILLER_WORDS:
                    j += 1
                    continue
                if candidate in PROMOTION_PIECES:
                    promotion_piece = PROMOTION_PIECES[candidate]
                    break
                if candidate in PIECE_WORDS and PIECE_WORDS[candidate]:
                    promotion_piece = PIECE_WORDS[candidate]
                    break
                j += 1
            if promotion_piece:
                mapped.append("=" + promotion_piece.upper())
                applied_rules.append(f"promotion to {promotion_piece.upper()}")
                i = j + 1
                continue
            mapped.append("=")
            applied_rules.append("promotion cue without piece")
            i += 1
            continue

        if token in CHECK_WORDS:
            mapped.append(CHECK_WORDS[token])
            applied_rules.append(f"mapped '{token}' -> '{CHECK_WORDS[token]}'")
            i += 1
            continue

        if token in ACTION_WORDS:
            mapped.append("x")
            applied_rules.append(f"mapped '{token}' -> 'x'")
            i += 1
            continue

        if token in {"b", "be", "bee"} and next_token in SHOP_VARIANTS:
            mapped.append("B")
            applied_rules.append("b + shop -> 'B'")
            i += 2
            continue

        if token in {"king", "queen"} and next_token in SIDE_VARIANTS:
            mapped.append(f"{token}side")
            applied_rules.append(f"{token} side collapsed")
            i += 2
            continue

        if token in {"kingside", "shortside"}:
            mapped.append("O-O")
            applied_rules.append(f"{token} -> O-O")
            i += 1
            continue

        if token in {"queenside", "longside"}:
            mapped.append("O-O-O")
            applied_rules.append(f"{token} -> O-O-O")
            i += 1
            continue

        if token in PIECE_WORDS:
            piece = PIECE_WORDS[token]
            if piece:
                mapped.append(piece.upper())
                applied_rules.append(f"piece '{token}' -> '{piece.upper()}'")
            else:
                applied_rules.append(f"dropped pawn token '{token}'")
            i += 1
            continue

        if token in NUMBER_WORDS:
            mapped.append(NUMBER_WORDS[token])
            applied_rules.append(f"number word '{token}' -> '{NUMBER_WORDS[token]}'")
            i += 1
            continue

        if token in LETTER_WORDS:
            mapped.append(LETTER_WORDS[token])
            applied_rules.append(f"letter word '{token}' -> '{LETTER_WORDS[token]}'")
            i += 1
            continue

        mapped.append(token)
        i += 1
    return mapped


def _format_token(token: str) -> str:
    if token in {"O-O", "O-O-O", "+", "#"}:
        return token
    if token.startswith("="):
        return token.upper()
    if token == "x":
        return "x"
    if SQUARE_REGEX.match(token):
        return token.lower()
    if PIECE_REGEX.match(token.upper()):
        return token.upper()
    return token


def _generate_candidates(tokens: Sequence[str], applied_rules: List[str]) -> List[str]:
    if not tokens:
        return []

    formatted_tokens = [_format_token(t) for t in tokens if t]
    promotion_tokens = [t for t in formatted_tokens if t.startswith("=")]
    non_promo_tokens = [t for t in formatted_tokens if not t.startswith("=")]

    if promotion_tokens:
        insert_at = -1
        for idx, tok in enumerate(non_promo_tokens):
            if SQUARE_REGEX.match(tok):
                insert_at = idx
        if insert_at >= 0:
            for promo in promotion_tokens:
                insert_at += 1
                non_promo_tokens.insert(insert_at, promo)
        else:
            non_promo_tokens.extend(promotion_tokens)

    base = "".join(non_promo_tokens)
    ordered_candidates: List[str] = []

    def add_candidate(value: str) -> None:
        if value and value not in ordered_candidates:
            ordered_candidates.append(value)

    add_candidate(base)

    if base and base[0].isupper() and len(base) >= 2 and base[0] != "O":
        add_candidate(base[0].lower() + base[1:])

    squares = [t.lower() for t in non_promo_tokens if SQUARE_REGEX.match(t)]
    if len(squares) >= 2:
        promotion_suffix = ""
        for tok in promotion_tokens:
            if len(tok) == 2:
                promotion_suffix = tok[1].lower()
                break
        uci = squares[0] + squares[1] + promotion_suffix
        add_candidate(uci)
        applied_rules.append(f"generated UCI candidate '{uci}'")

    if base and base[0].islower():
        add_candidate(base.lower())

    return ordered_candidates


def normalize_transcription(raw_text: Optional[str]) -> NormalizationResult:
    """Normalize STT output into structured move candidates."""
    if not raw_text:
        return NormalizationResult(
            raw_text=raw_text or "",
            cleaned_text="",
            tokens=[],
            merged_tokens=[],
            candidates=[],
            direct_candidates=[],
            applied_rules=["empty input"],
        )

    applied_rules: List[str] = []
    direct_candidates = _generate_direct_candidates(raw_text, applied_rules)
    cleaned = raw_text.lower().strip()
    cleaned = cleaned.replace("’", "'")
    cleaned = cleaned.replace("-", " ")
    cleaned = _apply_replacements(cleaned, MULTIWORD_REPLACEMENTS, applied_rules)
    cleaned = _apply_replacements(cleaned, CASTLING_PATTERNS, applied_rules)
    cleaned = re.sub(r"[^a-z0-9\s+#=]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    tokens = _tokenize(cleaned)
    mapped = _map_tokens(tokens, applied_rules)
    merged = _combine_letter_digit_tokens(mapped)
    merged = _merge_square_tokens(merged)
    generated_candidates = _generate_candidates(merged, applied_rules)

    combined_candidates: List[str] = []
    for source in (direct_candidates, generated_candidates):
        for cand in source:
            if cand and cand not in combined_candidates:
                combined_candidates.append(cand)

    return NormalizationResult(
        raw_text=raw_text,
        cleaned_text=cleaned,
        tokens=list(tokens),
        merged_tokens=list(merged),
        candidates=combined_candidates,
        direct_candidates=direct_candidates,
        applied_rules=applied_rules,
    )


__all__ = ["NormalizationResult", "normalize_transcription"]

