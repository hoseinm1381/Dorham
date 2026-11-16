package main

import (
	"net/netip"
	"testing"
)

func TestStationAddressBoundaries(t *testing.T) {
	for _, blocked := range []string{"127.0.0.1", "169.254.169.254", "10.0.1.2", "100.100.100.200", "::ffff:127.0.0.1", "fc00::1", "fe80::100", "64:ff9b::a9fe:a9fe", "2002:7f00:1::1"} {
		if publicStationIP(netip.MustParseAddr(blocked)) {
			t.Errorf("accepted internal station address %s", blocked)
		}
	}
	for _, allowed := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !publicStationIP(netip.MustParseAddr(allowed)) {
			t.Errorf("rejected public station address %s", allowed)
		}
	}
}
