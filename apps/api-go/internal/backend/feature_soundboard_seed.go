package backend

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
)

//go:embed soundboard_defaults/*
var defaultSounds embed.FS

type defaultSound struct {
	ID, File, Label, Pack, Access string
	Slot                          int
}

func (a *App) seedSoundboard() {
	raw, err := defaultSounds.ReadFile("soundboard_defaults/manifest.json")
	if err != nil {
		panic(err)
	}
	var sounds []defaultSound
	if err := json.Unmarshal(raw, &sounds); err != nil {
		panic(err)
	}
	if len(sounds) == 0 {
		return
	}
	a.DB.Tx(func(tx *DB) any {
		seeded := false
		for _, sound := range sounds {
			if tx.One("SELECT id FROM feature_catalog WHERE id=?", sound.ID) != nil {
				continue
			}
			var slot any
			if sound.Slot > 0 {
				Check(sound.Slot <= 8 && sound.Access == "free", 500, "INTERNAL", "Invalid free sound slot.")
				if tx.One("SELECT id FROM feature_catalog WHERE free_slot=? AND active=1", sound.Slot) != nil {
					continue
				}
				slot = sound.Slot
			}
			encoded, err := defaultSounds.ReadFile("soundboard_defaults/" + sound.File)
			if err != nil {
				panic(err)
			}
			data, mime := validateCatalogSound(encoded)
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			catalogPutFile(filepath.Join(a.C.DataDir, "catalog"), digest, data)
			tx.Run("INSERT INTO feature_catalog(id,kind,label,pack,digest,mime,bytes,access,free_slot,active,published) VALUES(?,'sound',?,?,?,?,?,?,?,1,1)", sound.ID, sound.Label, sound.Pack, digest, mime, len(data), sound.Access, slot)
			seeded = true
		}
		if seeded {
			writeFeatureSetting(tx, "catalogRevision", M{})
		}
		return nil
	})
}
