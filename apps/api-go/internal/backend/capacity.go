package backend

const maxCapacityValue = 1<<53 - 1 // Largest integer represented exactly in JSON clients.

type instanceCapacity struct {
	Users       int64 `json:"users"`
	Connections int64 `json:"connections"`
	Revision    int64 `json:"revision"`
}

func readCapacity(db *DB, c Config) instanceCapacity {
	capacity := instanceCapacity{Users: int64(c.MaxUsers), Connections: int64(c.MaxOnline)}
	if row := db.One("SELECT value,revision FROM feature_settings WHERE id='capacity'"); row != nil {
		settings := Obj(Parse(Str(row, "value")))
		capacity.Users = Num(settings, "users")
		capacity.Connections = Num(settings, "connections")
		capacity.Revision = Num(row, "revision")
	}
	return capacity
}

func (a *App) setCapacity(r *Request) any {
	Strict(r.Body, "users", "connections", "revision")
	result := featureAdmin(r, func(tx *DB) any {
		users := VInt(r.Body, "users", 1, maxCapacityValue)
		connections := VInt(r.Body, "connections", 1, maxCapacityValue)
		revision := VInt(r.Body, "revision", 0, maxCapacityValue)
		before := readCapacity(tx, a.C)
		if before.Users == users && before.Connections == connections {
			return before
		}
		Check(before.Revision == revision, 409, "CAPACITY_CHANGED", "Capacity limits have changed. Reload settings before saving.")
		writeFeatureSetting(tx, "capacity", M{"users": users, "connections": connections})
		Audit(tx, r.UID(), "admin.capacity", "instance", M{"previousUsers": before.Users, "previousConnections": before.Connections, "users": users, "connections": connections})
		return readCapacity(tx, a.C)
	}).(instanceCapacity)
	a.Hub.updateCapacity(result)
	return result
}
