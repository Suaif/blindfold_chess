import ollama
import chess
import re
import random
from typing import Optional, Dict, Any

class ChatAssistant:
    def __init__(self):
        self.ollama_client = ollama.Client()
        # Store info about the last TEST question asked (if any)
        # Structure: {'type': str, 'question': str, 'answer': str}
        self.pending_test: Optional[Dict[str, Any]] = None
    
    def generate_recap(self, game_state):
        moves = game_state.move_history
        if not moves:
            return "No moves have been made yet."
        
        recap = "Game recap:\n"
        for i, move in enumerate(moves):
            if i % 2 == 0:
                recap += f"{i//2 + 1}. {move}"
            else:
                recap += f" {move}\n"
        
        if len(moves) % 2 == 1:
            recap += "\n"
        
        recap += f"\nTotal moves: {len(moves)}"
        return recap
    
    def generate_test_question(self, game_state, color="none", question_type="none"):
        board = game_state.board
        test_questions = ["checks", "captures", "where", "what"]
        if question_type == "none":
            question_type = random.choice(test_questions)
        # Resolve color to a normalized string we can use throughout
        if color == "none":
            white_or_black = random.choice(["white", "black"])
        else:
            white_or_black = "white" if str(color).lower() == "white" else "black"
                
        if question_type == "checks":
            question = f"How many checks has {white_or_black} now?"
            n, checks = 0, []
            b = board.copy()
            b.turn = chess.WHITE if white_or_black == "white" else chess.BLACK
            for move in list(b.legal_moves):
                san = b.san(move)
                b.push(move)
                if b.is_check():
                    n += 1
                    checks.append(san)
                b.pop()
            answer = f"{n} checks: {', '.join(checks)}"
        elif question_type == "captures":
            question = f"How many captures has {white_or_black} now?"
            n, captures = 0, []
            b = board.copy()
            b.turn = chess.WHITE if white_or_black == "white" else chess.BLACK
            for move in list(b.legal_moves):
                san = b.san(move)
                if b.is_capture(move):
                    n += 1
                    captures.append(san)
            answer = f"{n} captures: {', '.join(captures)}"
        elif question_type == "where":
            piece = random.choice(["king", "queen", "rook", "bishop", "knight"])
            # Map piece names to chess piece types
            piece_map = {
                "king": chess.KING,
                "queen": chess.QUEEN,
                "rook": chess.ROOK,
                "bishop": chess.BISHOP,
                "knight": chess.KNIGHT
            }
            
            # Determine color flag for python-chess
            color_flag = chess.WHITE if white_or_black == "white" else chess.BLACK
            
            # Get the piece type constant
            piece_const = piece_map[piece]
            
            if piece in ["king", "queen"]:
                question = f"Where is the {white_or_black} {piece}?"
                
                # Find the piece on the board
                pieces = board.pieces(piece_const, color_flag)
                if pieces:
                    answer = chess.square_name(pieces.pop())
                else:
                    answer = f"There is no {white_or_black} {piece}"
            
            elif piece in ["rook", "bishop", "knight"]:
                question = f"Where is one of the {white_or_black} {piece}s?"
                
                # Find all pieces of this type
                pieces = board.pieces(piece_const, color_flag)
                answer_list = [chess.square_name(sq) for sq in pieces]
                
                if len(answer_list) == 0:
                    answer = f"There is no {white_or_black} {piece}"
                elif len(answer_list) == 1:
                    answer = answer_list[0]
                else:
                    answer = ", ".join(answer_list)
            
            return question, (answer.lower() if isinstance(answer, str) else answer)


        elif question_type == "what":
            row = random.choice(["1", "2", "3", "4", "5", "6", "7", "8"])
            column = random.choice(["a", "b", "c", "d", "e", "f", "g", "h"])
            square = column + row
            question = f"What piece is on {square} now?"

            # Parse the square name to get the square index
            square_idx = chess.parse_square(square)
            
            # Get the piece at that square
            piece = board.piece_at(square_idx)
            
            if piece is None:
                answer = "empty"
            else:
                # Map piece types to readable names
                piece_names = {
                    chess.PAWN: "pawn",
                    chess.KNIGHT: "knight",
                    chess.BISHOP: "bishop",
                    chess.ROOK: "rook",
                    chess.QUEEN: "queen",
                    chess.KING: "king"
                }
                
                color_name = "white" if piece.color == chess.WHITE else "black"
                piece_name = piece_names[piece.piece_type]
                answer = f"{color_name} {piece_name}"
        return question, answer
    
    def _parse_int_from_text(self, text: str) -> Optional[int]:
        """Parse an integer from free-form English (e.g., 'four', '4')."""
        s = (text or "").strip().lower()
        if not s:
            return None
        m = re.search(r"\d+", s)
        if m:
            try:
                return int(m.group(0))
            except Exception:
                pass
        # Map number words and common homophones to integers
        words = {
            "zero": 0, "oh": 0, "owe": 0,
            "one": 1, "won": 1,
            "two": 2, "too": 2, "to": 2, "tu": 2,
            "three": 3, "tree": 3, "free": 3,
            "four": 4, "for": 4, "fore": 4,
            "five": 5, "fife": 5,
            "six": 6,
            "seven": 7,
            "eight": 8, "ate": 8, "ait": 8,
            "nine": 9,
            "ten": 10,
            "eleven": 11,
            "twelve": 12,
            "thirteen": 13,
            "fourteen": 14,
            "fifteen": 15,
            "sixteen": 16,
            "seventeen": 17,
            "eighteen": 18,
            "nineteen": 19,
            "twenty": 20,
        }
        tokens = re.findall(r"[a-z]+", s)
        for t in tokens:
            if t in words:
                return words[t]
        return None

    def _normalize_number_words_to_digits(self, text: str) -> str:
        """Replace standalone number words and homophones with digits (e.g., 'for' -> '4')."""
        if not text:
            return text
        s = str(text)
        mapping = {
            "zero": "0", "oh": "0", "owe": "0",
            "one": "1", "won": "1",
            "two": "2", "too": "2", "to": "2", "tu": "2",
            "three": "3", "tree": "3", "free": "3",
            "four": "4", "for": "4", "fore": "4",
            "five": "5", "fife": "5",
            "six": "6",
            "seven": "7",
            "eight": "8", "ate": "8", "ait": "8",
            "nine": "9",
        }
        def repl(m: re.Match) -> str:
            w = m.group(0)
            return mapping.get(w.lower(), w)
        return re.sub(r"\b[a-z]+\b", repl, s)
    
    def get_piece_position(self, board, color_str, piece_str):
        """
        Get the position(s) of a specific piece
        
        Args:
            board: chess.Board object
            color_str: 'white' or 'black'
            piece_str: 'king', 'queen', 'rook', 'bishop', 'knight', or 'pawn'
        
        Returns:
            str or list: Square name(s) where the piece is located
        """
        # Map piece names to chess piece types
        piece_map = {
            "king": chess.KING,
            "queen": chess.QUEEN,
            "rook": chess.ROOK,
            "bishop": chess.BISHOP,
            "knight": chess.KNIGHT,
            "pawn": chess.PAWN
        }
        
        # Determine color
        color = chess.WHITE if color_str.lower() == "white" else chess.BLACK
        
        # Get the piece type constant
        piece_type = piece_map[piece_str.lower()]
        
        # Find all pieces of this type
        pieces = board.pieces(piece_type, color)
        positions = [chess.square_name(sq) for sq in pieces]
        
        if len(positions) == 0:
            return f"No {color_str} {piece_str} on the board"
        elif len(positions) == 1:
            return positions[0]
        else:
            return positions
    
    async def process_message(self, message: str, game_state):
        message = message.lower()
        
        # -------------------------------------------------------------
        # 1. If we are awaiting an answer to the previous TEST question,
        #    evaluate the user's reply before handling any other commands.
        # -------------------------------------------------------------
        if self.pending_test is not None and message != "test":
            # The user is attempting to answer the pending test.
            if "other" in message:
                # A new test question is requested. Reset the state and return.
                color, question_type = "none", "none"
                if "white" in message:
                    color = "white"
                elif "black" in message:
                    color = "black"
                if "checks" in message:
                    question_type = "checks"
                elif "captures" in message:
                    question_type = "captures"
                elif "where" in message:
                    question_type = "where"
                elif "what" in message:
                    question_type = "what"
                    
                question, answer = self.generate_test_question(game_state, color, question_type)
                # Store the new test in structured form
                self.pending_test = {"type": question_type, "question": question, "answer": answer}
                return f"TEST QUESTION: {question}"
            
            try:
                pt = self.pending_test or {}
                qtype = (pt.get("type") or "").lower()
                # Numeric evaluation for checks/captures: expect only a number as answer
                if qtype in ("checks", "captures"):
                    # Expected number is the first integer in the stored answer string
                    expected = None
                    m = re.match(r"\s*(\d+)", str(pt.get("answer") or ""))
                    if m:
                        expected = int(m.group(1))
                    user_n = self._parse_int_from_text(message)
                    if expected is not None and user_n is not None:
                        correct = (user_n == expected)
                        verdict = "Correct" if correct else f"Incorrect. It is {expected}."
                        detailed = str(pt.get("answer") or "")
                        self.pending_test = None
                        return f"{verdict}\n({detailed})"

                # Fallback to LLM-based brief evaluation for other test types
                system_prompt = f"""
                You are a helpful chess training assistant and you need to evaluate the user's answer to the test question.
                
                The question is: {pt.get('question')}
                              
                The correct answer is: {pt.get('answer')}
                
                Answer very briefly and directly: Correct/Incorrect
                """
                # Normalize numeric homophones so the LLM sees canonical digits
                normalized_msg = self._normalize_number_words_to_digits(message)
                user_message = f"User's answer: {normalized_msg}"

                response = self.ollama_client.chat(
                    model='llama3.2:3b',
                    messages=[
                        {'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': user_message}
                    ]
                )
                answer = f"{response['message']['content']}\n ({pt.get('answer')})"
                self.pending_test = None
                return answer
            except Exception as e:
                return f"I'm having trouble processing that question {e}. Please try again."

        # -------------------------------------------------------------
        # 2. Handle regular commands
        # -------------------------------------------------------------
        if message == "recap":
            return self.generate_recap(game_state)
        elif "test" in message:
            # Generate a new test question. Only return the question to the user and
            # store the expected answer so that we can validate their reply in the
            # next turn.
            color, question_type = "none", "none"
            if "white" in message:
                color = "white"
            elif "black" in message:
                color = "black"
            if "checks" in message:
                question_type = "checks"
            elif "captures" in message:
                question_type = "captures"
            elif "where" in message:
                question_type = "where"
            elif "what" in message:
                question_type = "what"
            # If not specified, pick a random type here so we can store it
            if question_type == "none":
                question_type = random.choice(["checks", "captures", "where", "what"])            
            
            question, answer = self.generate_test_question(game_state, color, question_type)
            # Store structured pending test for later evaluation
            self.pending_test = {"type": question_type, "question": question, "answer": answer}
            return f"TEST QUESTION: {question}"
        elif "where" in message:
            color = "white" if "white" in message else "black"
            # Extract piece type
            if "queen" in message:
                piece = "queen"
            elif "rook" in message:
                piece = "rook"
            elif "bishop" in message:
                piece = "bishop"
            elif "knight" in message:
                piece = "knight"
            elif "pawn" in message:
                piece = "pawn"
            elif "king" in message:
                piece = "king"
            else:
                piece = "piece"
            return self.get_piece_position(game_state.board, color, piece)
        elif "what" in message:
            square_pattern = r'\b([a-h][1-8])\b'
            match = re.search(square_pattern, message)
            
            if match:
                square = match.group(1)
                square_idx = chess.parse_square(square)
                piece = game_state.board.piece_at(square_idx)
                
                if piece is None:
                    return f"Square {square} is empty"
                else:
                    piece_names = {
                        chess.PAWN: "pawn",
                        chess.KNIGHT: "knight",
                        chess.BISHOP: "bishop",
                        chess.ROOK: "rook",
                        chess.QUEEN: "queen",
                        chess.KING: "king"
                    }
                    color_name = "white" if piece.color == chess.WHITE else "black"
                    piece_name = piece_names[piece.piece_type]
                    return f"There is a {color_name} {piece_name} on {square}"
            else:
                return "Please specify a square (e.g., 'what is on e4?')"
        
        else:
            return "I don't understand that command. Try 'where is the white queen?' or 'what is on e4?'"
