package backend

import "testing"

func TestGameDeltaIncludesNewNullFields(t *testing.T) {
	before := M{"phase": "lobby", "old": nil, "stable": nil}
	after := M{"phase": "quick-pick", "ownEntry": nil, "stable": nil}
	changed, removed := gameFields(before, after, "")
	if value, exists := changed["ownEntry"]; !exists || value != nil {
		t.Fatalf("a new nullable field must be sent to waiting players: %v", changed)
	}
	if len(changed) != 2 || changed["phase"] != "quick-pick" || len(removed) != 1 || removed[0] != "old" {
		t.Fatalf("unexpected field patch: changed=%v removed=%v", changed, removed)
	}
}
