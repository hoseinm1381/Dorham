package backend

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

func normalizeMessageSearch(text string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == 'ي' || r == 'ى':
			return 'ی'
		case r == 'ك':
			return 'ک'
		case r >= '۰' && r <= '۹':
			return '0' + r - '۰'
		case r >= '٠' && r <= '٩':
			return '0' + r - '٠'
		case unicode.IsSpace(r) || unicode.Is(unicode.Mn, r) || r == '\u200c' || r == '\u200d' || r == '\u0640':
			return -1
		default:
			return unicode.ToLower(r)
		}
	}, norm.NFKC.String(text))
}

func (s *Service) SearchMessages(uid, conversation, server, query, beforeID string, before int64) M {
	query = normalizeMessageSearch(query)
	length := len([]rune(query))
	Check(length >= 2 && length <= 120, 400, "VALIDATION", "Search for 2 to 120 characters.")
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		ids := []string{conversation}
		if server != "" {
			s.Member(tx, uid, server)
			ids = []string{}
			for _, channel := range tx.All("SELECT id,conversation_id FROM channels WHERE server_id=? AND kind='text'", server) {
				err := serviceAttempt(func() { s.Channel(tx, uid, Str(channel, "id")) })
				if err != nil {
					if failure, ok := err.(APIError); ok && failure.Status == 403 {
						continue
					}
					panic(err)
				}
				ids = append(ids, Str(channel, "conversation_id"))
			}
		} else {
			s.Conversation(tx, uid, conversation)
		}
		results := []M{}
		if len(ids) == 0 {
			return M{"messages": results}
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		args := make([]any, 0, len(ids)+3)
		for _, id := range ids {
			args = append(args, id)
		}
		args = append(args, before, before, beforeID)
		rows := tx.All("SELECT id,content,created_at FROM messages WHERE deleted=0 AND conversation_id IN ("+placeholders+") AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 500", args...)
		matches := []string{}
		var cursor M
		for i, row := range rows {
			if strings.Contains(normalizeMessageSearch(Str(row, "content")), query) {
				matches = append(matches, Str(row, "id"))
			}
			if len(matches) == 25 || i+1 == 500 {
				cursor = M{"before": Num(row, "created_at"), "beforeId": Str(row, "id")}
				break
			}
		}
		if len(matches) > 0 {
			results = s.MessageViews(tx, matches)
		}
		return M{"messages": results, "cursor": cursor}
	}))
}

func (s *Service) MessageContext(uid, conversation, message string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation)
		row := tx.One("SELECT sequence FROM messages WHERE id=? AND conversation_id=?", message, conversation)
		Check(row != nil, 404, "NOT_FOUND", "That message is no longer available.")
		sequence := Num(row, "sequence")
		older := tx.All("SELECT id FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 26", conversation, sequence)
		newer := tx.All("SELECT id FROM messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 26", conversation, sequence)
		ids := []string{}
		for i := min(25, len(older)) - 1; i >= 0; i-- {
			ids = append(ids, Str(older[i], "id"))
		}
		ids = append(ids, message)
		for _, newerRow := range newer[:min(25, len(newer))] {
			ids = append(ids, Str(newerRow, "id"))
		}
		return M{"messages": s.MessageViews(tx, ids), "sequence": Num(cv, "sequence"), "hasMore": len(older) > 25, "hasNewer": len(newer) > 25}
	}))
}

func (s *Service) PinnedMessages(uid, conversation string) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		s.Conversation(tx, uid, conversation)
		ids := []string{}
		for _, row := range tx.All("SELECT p.message_id FROM message_pins p JOIN messages m ON m.id=p.message_id WHERE p.conversation_id=? AND m.deleted=0 ORDER BY p.created_at DESC LIMIT 25", conversation) {
			ids = append(ids, Str(row, "message_id"))
		}
		return M{"messages": s.MessageViews(tx, ids)}
	}))
}

func (s *Service) PinMessage(uid, rid, conversation, message string, pinned bool) M {
	return serviceResult(s.Mutate(uid, rid, "message.pin", M{"conversationId": conversation, "messageId": message, "pinned": pinned}, func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation, true)
		if Str(cv, "kind") != "dm" {
			ch := tx.One("SELECT id FROM channels WHERE conversation_id=?", conversation)
			s.Channel(tx, uid, Str(ch, "id"), "moderate")
		}
		Check(tx.One("SELECT id FROM messages WHERE id=? AND conversation_id=? AND deleted=0", message, conversation) != nil, 404, "NOT_FOUND", "That message is no longer available.")
		if pinned {
			tx.Run("DELETE FROM message_pins WHERE conversation_id=? AND message_id IN (SELECT id FROM messages WHERE conversation_id=? AND deleted<>0)", conversation, conversation)
			if tx.One("SELECT message_id FROM message_pins WHERE message_id=?", message) == nil {
				Check(Num(tx.One("SELECT COUNT(*) AS count FROM message_pins WHERE conversation_id=?", conversation), "count") < 25, 409, "PIN_LIMIT", "Unpin a message before adding another.")
				tx.Run("INSERT INTO message_pins(message_id,conversation_id,created_at) VALUES(?,?,?) ON CONFLICT(message_id) DO NOTHING", message, conversation, Now())
			}
		} else {
			tx.Run("DELETE FROM message_pins WHERE message_id=?", message)
		}
		return M{"success": true}
	}))
}
