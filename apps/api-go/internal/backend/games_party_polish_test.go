package backend

import "testing"

func TestLudoFourthTokenFinishesGame(t *testing.T) {
	game := startGameEngine("ludo", 2, M{}, 0)
	game["phase"] = "move"
	game["die"] = 1
	game["tokens"] = []any{[]any{56, 56, 56, 55}, []any{8, 8, 8, 8}}
	if legal := JSON(gameProject("ludo", game, 0)["legal"]); legal != "[3]" {
		t.Fatalf("only the fourth token can move, got %s", legal)
	}
	gameAct("ludo", game, 0, M{"type": "token", "piece": 3}, M{}, 1)
	if game["result"] != "Player 1 wins" || gi(game["winner"]) != 0 || N(game["deadline"]) != 0 {
		t.Fatalf("fourth token should finish the game: %s", JSON(game))
	}
	view := gameProject("ludo", game, 0)
	if tokens := JSON(Arr(view["tokens"])[0]); tokens != "[56,56,56,56]" || len(Arr(view["legal"])) != 0 {
		t.Fatalf("finished board must show all four at home and no legal action: %s", JSON(view))
	}
}

func TestDrawDominoesKeepsTurnUntilDrawnTileFits(t *testing.T) {
	tile := func(low, high int) int {
		for index, pair := range dominoTiles {
			if pair == [2]int{low, high} {
				return index
			}
		}
		t.Fatalf("missing domino tile %d–%d", low, high)
		return -1
	}
	settings := M{"domino": "draw"}
	game := startGameEngine("domino", 2, settings, 0)
	game["turn"] = 0
	game["chain"] = []any{[]any{6, 6}}
	game["hands"] = []any{[]any{tile(0, 0)}, []any{tile(2, 2)}}
	game["boneyard"] = []any{tile(2, 6), tile(1, 1)}

	gameAct("domino", game, 0, M{"type": "draw"}, settings, 1)
	view := gameProject("domino", game, 0)
	if gi(view["turn"]) != 0 || gi(view["boneyard"]) != 1 || len(Arr(view["legal"])) != 0 {
		t.Fatalf("mismatched draw changed the turn or became playable: %s", JSON(view))
	}
	gameAct("domino", game, 0, M{"type": "draw"}, settings, 2)
	view = gameProject("domino", game, 0)
	if gi(view["turn"]) != 0 || gi(view["boneyard"]) != 0 || len(Arr(view["legal"])) != 2 {
		t.Fatalf("matching draw should fit both ends: %s", JSON(view))
	}
	gameAct("domino", game, 0, M{"type": "tile", "tile": tile(2, 6), "end": "right"}, settings, 3)
	view = gameProject("domino", game, 1)
	if gi(view["turn"]) != 1 || JSON(view["chain"]) != "[[6,6],[6,2]]" {
		t.Fatalf("drawn tile did not join the correct end: %s", JSON(view))
	}
}
