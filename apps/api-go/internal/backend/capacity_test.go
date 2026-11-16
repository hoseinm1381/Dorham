package backend

import (
	"strings"
	"testing"
	"time"
)

func TestInstanceCapacityChangesThroughAdminAPI(t *testing.T) {
	a, server := integrationApp(t, func(c *Config) {
		c.MaxUsers = 2
		c.MaxOnline = 1
	})
	adminID, _, admin, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", adminID)
	memberID, _, member, _ := integrationSession(a, true)
	request := func(method, path, bearer string, body M, want int) M {
		t.Helper()
		result := integrationHTTP(a, method, "/api/v1/"+path, "", bearer, "", "", body)
		if result.Code != want {
			t.Fatalf("%s %s: got %d, want %d: %s", method, path, result.Code, want, result.Body)
		}
		return Obj(Parse(result.Body.String()))
	}
	read := Obj(request("GET", "admin/features", admin, nil, 200)["capacity"])
	if Num(read, "users") != 2 || Num(read, "connections") != 1 || Num(read, "revision") != 0 {
		t.Fatalf("incorrect configured defaults: %v", read)
	}
	register := M{"username": "new_account", "displayName": "New account", "password": "local-capacity-test", "requestId": ID()}
	refused := request("POST", "auth/register", "", register, 409)
	if !strings.Contains(JSON(refused), "ACCOUNT_LIMIT") {
		t.Fatalf("expected account capacity error, got %v", refused)
	}
	first, ok := integrationSocket(t, server.URL, "https://dorham.example", "", M{"token": member})
	if !ok {
		t.Fatal("first connection was refused")
	}
	deadline := time.Now().Add(time.Second)
	for !a.Hub.Online(memberID) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, ok := integrationSocket(t, server.URL, "https://dorham.example", "", M{"token": member}); ok {
		t.Fatal("a second connection from the same user bypassed the simultaneous limit")
	}
	const capacityPath = "admin/features/settings/capacity"
	settings := M{"users": 5000, "connections": 2, "revision": 0}
	request("PUT", capacityPath, member, settings, 403)
	request("PUT", capacityPath, admin, M{"users": 0, "connections": 2, "revision": 0}, 400)
	updated := request("PUT", capacityPath, admin, settings, 200)
	if Num(updated, "users") != 5000 || Num(updated, "connections") != 2 || Num(updated, "revision") != 1 {
		t.Fatalf("capacity update response: %v", updated)
	}
	request("PUT", capacityPath, admin, settings, 200)
	request("PUT", capacityPath, admin, M{"users": 250, "connections": 50, "revision": 0}, 409)
	request("POST", "auth/register", "", register, 201)
	if _, ok := integrationSocket(t, server.URL, "https://dorham.example", "", M{"token": member}); !ok {
		t.Fatal("increased limit did not admit the next connection")
	}
	read = Obj(request("GET", "admin/features", admin, nil, 200)["capacity"])
	if Num(read, "users") != 5000 || Num(read, "connections") != 2 || Num(a.DB.One("SELECT COUNT(*) AS count FROM audit_log WHERE action='admin.capacity'"), "count") != 1 {
		t.Fatalf("capacity or audit did not persist: %v", read)
	}
	first.Close()
}
