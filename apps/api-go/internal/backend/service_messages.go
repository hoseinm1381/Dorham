package backend

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var mentionProtectedStart = regexp.MustCompile("https?://|`")

func mentionProtectedRanges(text string) [][2]int {
	out := [][2]int{}
	last := 0
	for _, span := range mentionProtectedStart.FindAllStringIndex(text, -1) {
		start, end := span[0], span[1]
		if start < last {
			continue
		}
		if text[start] == '`' {
			if closing := strings.IndexByte(text[end:], '`'); closing >= 0 {
				end += closing + 1
			} else {
				end = len(text)
			}
		} else {
			for end < len(text) {
				r, n := utf8.DecodeRuneInString(text[end:])
				if serviceJSSpace(r) || r == '<' || r == '>' {
					break
				}
				end += n
			}
			if end == span[1] {
				continue
			}
		}
		out = append(out, [2]int{start, end})
		last = end
	}
	return out
}
func MentionNames(text string) []string {
	protected := mentionProtectedRanges(text)
	names := []string{}
	seen := map[string]bool{}
	for i := 0; i < len(text); i++ {
		if text[i] != '@' {
			continue
		}
		if i > 0 {
			r, _ := utf8.DecodeLastRuneInString(text[:i])
			if unicode.IsLetter(r) || unicode.IsNumber(r) || strings.ContainsRune("_/@\\", r) {
				continue
			}
		}
		hidden := false
		for _, span := range protected {
			if i >= span[0] && i < span[1] {
				hidden = true
				break
			}
		}
		if hidden {
			continue
		}
		end := i + 1
		for end < len(text) && ((text[end] >= 'A' && text[end] <= 'Z') || (text[end] >= 'a' && text[end] <= 'z') || (text[end] >= '0' && text[end] <= '9') || text[end] == '_') {
			end++
		}
		length := end - i - 1
		if length < 3 || length > 32 {
			continue
		}
		if end < len(text) {
			r, _ := utf8.DecodeRuneInString(text[end:])
			if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' {
				continue
			}
		}
		name := strings.ToLower(text[i+1 : end])
		if !seen[name] {
			names = append(names, name)
			seen[name] = true
		}
	}
	return names
}
func serviceJSSpace(r rune) bool {
	return (r >= 9 && r <= 13) || unicode.Is(unicode.Zs, r) || r == '\u2028' || r == '\u2029' || r == '\ufeff'
}
func TTSMessage(content string) (bool, string) {
	trim := strings.TrimFunc(content, serviceJSSpace)
	if len(trim) >= 4 && strings.EqualFold(trim[:4], "/tts") {
		suffix := trim[4:]
		if suffix == "" {
			return true, ""
		}
		r, _ := utf8.DecodeRuneInString(suffix)
		if serviceJSSpace(r) {
			return true, strings.TrimFunc(suffix, serviceJSSpace)
		}
	}
	return false, content
}
func (s *Service) ReplaceMentions(tx *DB, id, conversation, author, content string) {
	tx.Run("DELETE FROM message_mentions WHERE message_id=?", id)
	names := MentionNames(content)
	if len(names) == 0 {
		return
	}
	ch := tx.One("SELECT id,server_id FROM channels WHERE conversation_id=?", conversation)
	if ch == nil {
		return
	}
	args := []any{ch["server_id"]}
	for _, name := range names {
		args = append(args, name)
	}
	args = append(args, author, author)
	rows := tx.All("SELECT u.id,u.username FROM users u JOIN members m ON m.user_id=u.id WHERE m.server_id=? AND u.banned=0 AND u.must_change_password=0 AND LOWER(u.username) IN ("+servicePlaceholders(len(names))+") AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id=u.id AND b.blocked_id=?) OR (b.user_id=? AND b.blocked_id=u.id))", args...)
	for _, u := range rows {
		err := serviceAttempt(func() { s.Channel(tx, S(u["id"]), S(ch["id"])) })
		if err != nil {
			if serviceAuthorizationError(err) {
				continue
			}
			panic(err)
		}
		tx.Run("INSERT INTO message_mentions(message_id,user_id,username) VALUES(?,?,?)", id, u["id"], u["username"])
	}
}
func (s *Service) MessageView(tx *DB, id string) M {
	m := tx.One("SELECT m.*,u.username,u.display_name,u.bio,u.avatar,u.status,u.instance_admin,u.guest,u.language FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=?", id)
	Check(m != nil, 404, "NOT_FOUND", "Message not found.")
	reactions := []M{}
	indices := map[string]int{}
	for _, r := range tx.All("SELECT emoji,user_id FROM reactions WHERE message_id=?", id) {
		emoji := S(r["emoji"])
		index, ok := indices[emoji]
		if !ok {
			index = len(reactions)
			indices[emoji] = index
			reactions = append(reactions, M{"emoji": emoji, "userIds": []string{}})
		}
		reactions[index]["userIds"] = append(reactions[index]["userIds"].([]string), S(r["user_id"]))
	}
	deleted := B(m["deleted"])
	mentions := []M{}
	attachments := []M{}
	content := S(m["content"])
	if deleted {
		content = ""
	} else {
		for _, u := range tx.All("SELECT mm.user_id,mm.username,u.display_name FROM message_mentions mm JOIN users u ON u.id=mm.user_id WHERE mm.message_id=?", id) {
			mentions = append(mentions, M{"userId": u["user_id"], "username": u["username"], "displayName": u["display_name"]})
		}
		for _, a := range tx.All("SELECT * FROM attachments WHERE message_id=?", id) {
			attachments = append(attachments, M{"id": a["id"], "name": a["name"], "size": N(a["size"]), "expiresAt": N(a["expires_at"]), "available": S(a["state"]) == "ready" && N(a["expires_at"]) > Now()})
		}
	}
	var edited any
	if N(m["edited_at"]) != 0 {
		edited = N(m["edited_at"])
	}
	return M{"id": m["id"], "conversationId": m["conversation_id"], "sequence": N(m["sequence"]), "author": PublicUser(Merge(m, M{"id": m["user_id"]})), "content": content, "replyTo": m["reply_to"], "createdAt": N(m["created_at"]), "editedAt": edited, "deleted": deleted, "reactions": reactions, "mentions": mentions, "attachments": attachments}
}
func (s *Service) Event(tx *DB, conversation, kind string, payload any) M {
	tx.Run("UPDATE conversations SET sequence=sequence+1 WHERE id=?", conversation)
	cv := tx.One("SELECT sequence,kind FROM conversations WHERE id=?", conversation)
	event := M{"conversationId": conversation, "sequence": N(cv["sequence"]), "kind": kind, "payload": payload, "direct": S(cv["kind"]) == "dm"}
	if N(tx.One("SELECT COUNT(*) AS count FROM events")["count"]) >= 50000 {
		tx.Run("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY created_at LIMIT 200)")
	}
	tx.Run("INSERT INTO events(id,conversation_id,sequence,kind,payload,created_at) VALUES(?,?,?,?,?,?)", ID(), conversation, event["sequence"], kind, JSON(payload), Now())
	return event
}

type ServiceUndefined struct{}

func (s *Service) Send(uid, rid, conversation, content string, replyTo any, attachmentIDs []string, asTTS bool) M {
	reopened, posted := false, false
	requested, text := TTSMessage(content)
	Check(text != "" || len(attachmentIDs) > 0, 400, "VALIDATION", "Type a message after /tts.")
	if attachmentIDs == nil {
		attachmentIDs = []string{}
	}
	payload := M{"conversationId": conversation, "content": content, "attachmentIds": attachmentIDs}
	if _, missing := replyTo.(ServiceUndefined); !missing {
		payload["replyTo"] = replyTo
	} else {
		replyTo = nil
	}
	if asTTS {
		payload["tts"] = true
	}
	event := serviceResult(s.Mutate(uid, rid, "message.send", payload, func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation, true)
		guest := B(tx.One("SELECT guest FROM users WHERE id=?", uid)["guest"])
		if guest {
			Check(N(tx.One("SELECT COUNT(*) AS count FROM messages WHERE user_id=? AND created_at>?", uid, Now()-60000)["count"]) < 20, 429, "GUEST_RATE", "Guests may send at most 20 messages per minute.")
			Check(len(attachmentIDs) == 0, 403, "GUEST_UPLOAD", "Guests cannot upload files.")
		}
		for _, id := range attachmentIDs {
			Check(tx.One("SELECT id FROM attachments WHERE id=? AND user_id=? AND conversation_id=? AND state='ready' AND message_id IS NULL AND expires_at>?", id, uid, conversation, Now()) != nil, 400, "ATTACHMENT_INVALID", "An attachment is unavailable or belongs to another conversation.")
		}
		if S(replyTo) != "" {
			Check(tx.One("SELECT id FROM messages WHERE id=? AND conversation_id=?", replyTo, conversation) != nil, 400, "INVALID_REPLY", "Reply target is unavailable.")
		}
		if N(tx.One("SELECT COUNT(*) AS count FROM messages")["count"]) >= int64(s.C.MaxMessages) {
			tx.Run("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY created_at LIMIT 200)")
		}
		id := ID()
		var reply any
		if S(replyTo) != "" {
			reply = replyTo
		}
		tx.Run("INSERT INTO messages(id,conversation_id,sequence,user_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?)", id, conversation, N(cv["sequence"])+1, uid, text, reply, Now())
		s.ReplaceMentions(tx, id, conversation, uid, text)
		for _, a := range attachmentIDs {
			tx.Run("UPDATE attachments SET message_id=? WHERE id=?", id, a)
		}
		if S(cv["kind"]) == "dm" {
			reopened = tx.One("SELECT user_id FROM dm_members WHERE conversation_id=? AND hidden=1", conversation) != nil
			tx.Run("UPDATE dm_members SET hidden=0 WHERE conversation_id=?", conversation)
		}
		posted = true
		return s.Event(tx, conversation, "message", s.MessageView(tx, id))
	}))
	if reopened {
		s.Notify("state:changed", M{})
	}
	if posted {
		s.Notify("conversation:event", event)
	}
	if (requested || asTTS) && text != "" && s.OnTTS != nil {
		s.OnTTS(uid, Obj(event["payload"]))
	}
	return event
}
func (s *Service) ChangeMessage(uid, rid, id string, body M) M {
	event := serviceResult(s.Mutate(uid, rid, "message.change", servicePayload(M{"messageId": id}, body), func(tx *DB) any {
		m := tx.One("SELECT * FROM messages WHERE id=?", id)
		Check(m != nil, 404, "NOT_FOUND", "Message not found.")
		conversation := S(m["conversation_id"])
		cv := s.Conversation(tx, uid, conversation, true)
		if emoji := S(body["emoji"]); emoji != "" {
			Check(!B(m["deleted"]), 409, "DELETED", "Message has been deleted.")
			if B(body["removeReaction"]) {
				tx.Run("DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?", id, uid, emoji)
			} else {
				Check(N(tx.One("SELECT COUNT(*) AS count FROM reactions WHERE message_id=?", id)["count"]) < 100, 409, "LIMIT", "Reaction limit reached.")
				tx.Run("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?) ON CONFLICT DO NOTHING", id, uid, emoji)
			}
		} else {
			if S(m["user_id"]) != uid {
				var ch M
				if S(cv["kind"]) == "channel" {
					ch = tx.One("SELECT id FROM channels WHERE conversation_id=?", conversation)
				}
				Check(B(body["delete"]) && ch != nil, 403, "FORBIDDEN", "You can edit only your own messages.")
				s.Channel(tx, uid, S(ch["id"]), "moderate")
			}
			Check(!B(m["deleted"]), 409, "DELETED", "Message has been deleted.")
			content := S(body["content"])
			if B(body["delete"]) {
				content = ""
			}
			tx.Run("UPDATE messages SET content=?,deleted=?,edited_at=? WHERE id=?", content, serviceBoolInt(B(body["delete"])), Now(), id)
			s.ReplaceMentions(tx, id, conversation, S(m["user_id"]), content)
			if B(body["delete"]) {
				tx.Run("DELETE FROM reactions WHERE message_id=?", id)
				tx.Run("UPDATE attachments SET state='unavailable' WHERE message_id=?", id)
			}
		}
		return s.Event(tx, conversation, "message", s.MessageView(tx, id))
	}))
	s.Notify("conversation:event", event)
	return event
}
func (s *Service) History(uid, conversation string, before, after *int64) M {
	return serviceResult(s.DB.Tx(func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation)
		sequence := N(cv["sequence"])
		if after != nil {
			first := tx.One("SELECT MIN(sequence) AS first FROM events WHERE conversation_id=?", conversation)
			if *after > sequence || (*after < sequence && (first["first"] == nil || N(first["first"]) > *after+1)) {
				return M{"reset": true, "sequence": sequence, "events": []M{}}
			}
			events := []M{}
			for _, e := range tx.All("SELECT * FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 200", conversation, *after) {
				events = append(events, M{"conversationId": conversation, "sequence": N(e["sequence"]), "kind": e["kind"], "payload": Parse(S(e["payload"]))})
			}
			return M{"reset": false, "sequence": sequence, "events": events}
		}
		limit := int64(9007199254740991)
		if before != nil && *before != 0 {
			limit = *before
		}
		rows := tx.All("SELECT id FROM messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 50", conversation, limit)
		messages := []M{}
		for i := len(rows) - 1; i >= 0; i-- {
			messages = append(messages, s.MessageView(tx, S(rows[i]["id"])))
		}
		return M{"messages": messages, "sequence": sequence, "hasMore": len(rows) == 50}
	}))
}
func (s *Service) Read(uid, rid, conversation string, sequence int64) M {
	return serviceResult(s.Mutate(uid, rid, "conversation.read", M{"conversationId": conversation, "sequence": sequence}, func(tx *DB) any {
		cv := s.Conversation(tx, uid, conversation)
		old := tx.One("SELECT sequence FROM read_cursors WHERE conversation_id=? AND user_id=?", conversation, uid)
		tx.Run("INSERT INTO read_cursors(conversation_id,user_id,sequence) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET sequence=excluded.sequence", conversation, uid, max(N(old["sequence"]), min(sequence, N(cv["sequence"]))))
		return M{"success": true}
	}))
}
