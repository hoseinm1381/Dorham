package backend

func uploadAllowance(db *DB, uid string) int64 {
	if !featureAvailable(db, uid, "uploadsPlus") {
		return 300 * mediaMiB
	}
	settings := featureSetting(db, "uploads")
	if Bool(settings, "enabled") {
		return N(settings["dailyMiB"]) * mediaMiB
	}
	return 300 * mediaMiB
}
