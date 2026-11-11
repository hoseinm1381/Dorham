package backend

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type clientFeature struct {
	ID         string            `json:"id"`
	MinVersion string            `json:"minVersion"`
	Name       map[string]string `json:"name"`
	GameKinds  []string          `json:"gameKinds,omitempty"`
}

//go:embed client_features.json
var clientFeatureJSON []byte

var clientFeatures = loadClientFeatures()
var gameClientFeatures = func() map[string]clientFeature {
	out := map[string]clientFeature{}
	for _, feature := range clientFeatures {
		for _, kind := range feature.GameKinds {
			if _, exists := out[kind]; exists {
				panic("duplicate client requirement for game " + kind)
			}
			out[kind] = feature
		}
	}
	return out
}()

func loadClientFeatures() []clientFeature {
	var features []clientFeature
	if err := json.Unmarshal(clientFeatureJSON, &features); err != nil {
		panic(err)
	}
	seen := map[string]bool{}
	for _, feature := range features {
		_, valid := releaseVersionParts(feature.MinVersion)
		if feature.ID == "" || seen[feature.ID] || !valid || feature.Name["en"] == "" || feature.Name["fa"] == "" {
			panic("invalid client feature " + feature.ID)
		}
		seen[feature.ID] = true
	}
	return features
}

func releaseVersionParts(value string) ([3]uint64, bool) {
	var version [3]uint64
	if len(value) > 50 {
		return version, false
	}
	parts := strings.Split(value, ".")
	if len(parts) != len(version) {
		return version, false
	}
	for i, part := range parts {
		if len(part) > 1 && part[0] == '0' {
			return version, false
		}
		n, err := strconv.ParseUint(part, 10, 53)
		if err != nil {
			return version, false
		}
		version[i] = n
	}
	return version, true
}

func clientSupportsFeature(feature clientFeature, version string) bool {
	current, valid := releaseVersionParts(version)
	if !valid {
		return false
	}
	minimum, _ := releaseVersionParts(feature.MinVersion)
	for i, part := range current {
		if part != minimum[i] {
			return part > minimum[i]
		}
	}
	return true
}

func clientSupportsGame(kind, version string) bool {
	feature, required := gameClientFeatures[kind]
	return !required || clientSupportsFeature(feature, version)
}

func requireGameClient(kind, version string) {
	Check(clientSupportsGame(kind, version), 409, "APP_UPDATE_REQUIRED", "Update Dorham to use this game.")
}

func gameFeatureRequirements() []clientFeature {
	games := []clientFeature{}
	for _, feature := range clientFeatures {
		if len(feature.GameKinds) > 0 {
			games = append(games, feature)
		}
	}
	return games
}

func legacyClientFeatureNotices(platform, version string) []M {
	if platform != "web" && platform != "windows" && platform != "android" {
		return nil
	}
	if _, valid := releaseVersionParts(version); !valid {
		return nil
	}
	notices := []M{}
	for _, feature := range clientFeatures {
		if clientSupportsFeature(feature, version) {
			continue
		}
		en := fmt.Sprintf("Update Dorham to %s or later to use %s. Open Get apps to check for updates.", feature.MinVersion, feature.Name["en"])
		fa := fmt.Sprintf("برای استفاده از %s، دورهم را به نسخهٔ %s یا بالاتر به‌روزرسانی کنید. از بخش دریافت برنامه‌ها به‌روزرسانی‌ها را بررسی کنید.", feature.Name["fa"], feature.MinVersion)
		if platform == "web" {
			en = fmt.Sprintf("Refresh Dorham to use %s. Version %s or later is required.", feature.Name["en"], feature.MinVersion)
			fa = fmt.Sprintf("برای استفاده از %s، دورهم را دوباره بارگیری کنید. نسخهٔ %s یا بالاتر لازم است.", feature.Name["fa"], feature.MinVersion)
		}
		notices = append(notices, M{"id": "client-update:" + feature.ID, "en": en, "fa": fa})
	}
	return notices
}
