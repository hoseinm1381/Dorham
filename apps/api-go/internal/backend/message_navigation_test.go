package backend

import "testing"

func TestMessageSearchPinsAndScopedAudit(t *testing.T) {
	f := newCoreFixture(t)
	owner, member := f.users["owner"], f.users["member"]
	rid := ID()
	post := f.s.Send(owner, rid, f.conversation, "قرار يك‌شنبه ۱۲", nil, nil, false)
	id := Str(Obj(post["payload"]), "id")
	replay := f.s.Send(owner, rid, f.conversation, "قرار يك‌شنبه ۱۲", nil, nil, false)
	if Str(replay, "requestId") != rid || Str(Obj(replay["payload"]), "id") != id {
		t.Fatal("retry did not return matching receipt")
	}
	results := f.s.SearchMessages(member, "", f.server, "یک شنبه 12", "", Now()+1)
	rows, _ := results["messages"].([]M)
	if len(rows) != 1 || Str(rows[0], "id") != id {
		t.Fatalf("Persian server search did not normalize spelling and digits: %v", results)
	}
	coreWantError(t, "FORBIDDEN", func() { f.s.SearchMessages(f.users["outside"], f.conversation, "", "یکشنبه", "", Now()+1) })
	f.s.PinMessage(owner, ID(), f.conversation, id, true)
	pins, _ := f.s.PinnedMessages(member, f.conversation)["messages"].([]M)
	if len(pins) != 1 || Str(pins[0], "id") != id {
		t.Fatal("pin not visible to conversation members")
	}
	coreWantError(t, "FORBIDDEN", func() { f.s.PinMessage(member, ID(), f.conversation, id, false) })
	context, _ := f.s.MessageContext(member, f.conversation, id)["messages"].([]M)
	if len(context) != 1 || Str(context[0], "id") != id {
		t.Fatal("context did not include the requested message")
	}
	Audit(f.db, owner, "member.kick", member, M{"serverId": f.server, "reason": "test record"})
	Audit(f.db, owner, "member.kick", member, M{"serverId": ID(), "reason": "different server"})
	events, _ := f.s.ServerModerationLog(owner, f.server)["events"].([]M)
	if len(events) != 1 || Str(events[0], "reason") != "test record" {
		t.Fatal("moderation log did not stay within the requested server")
	}
	coreWantError(t, "FORBIDDEN", func() { f.s.ServerModerationLog(member, f.server) })
}
