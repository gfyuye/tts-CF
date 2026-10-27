package main

import (
	"strings"
	"testing"
)

func TestEncodeURIComponent(t *testing.T) {
	cases := map[string]string{
		"abc123":              "abc123",
		"a-b_c.d!e~f*g'h(i)j": "a-b_c.d!e~f*g'h(i)j",
		"a b":                 "a%20b",
		"a/b:c?d=e&f":         "a%2Fb%3Ac%3Fd%3De%26f",
		"中文":                  "%E4%B8%AD%E6%96%87",
	}
	for input, expected := range cases {
		if got := encodeURIComponent(input); got != expected {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestDateFormat(t *testing.T) {
	s := dateFormat()
	if !strings.HasSuffix(s, " gmt") {
		t.Errorf("dateFormat() = %q, want suffix ' gmt'", s)
	}
	if strings.Contains(s, "UTC") || strings.Contains(s, "GMT") {
		t.Errorf("dateFormat() = %q, should not contain UTC/GMT", s)
	}
	if len(s) < 25 {
		t.Errorf("dateFormat() = %q, too short", s)
	}
}

func TestUUID(t *testing.T) {
	s := uuid()
	if len(s) != 32 {
		t.Errorf("uuid() length = %d, want 32", len(s))
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("uuid() contains invalid char: %c", c)
		}
	}
	if s[12] != '4' {
		t.Errorf("uuid() version = %c, want 4", s[12])
	}
	if !strings.ContainsRune("89ab", rune(s[16])) {
		t.Errorf("uuid() variant = %c, want 8/9/a/b", s[16])
	}
}

func TestGenerateUserID(t *testing.T) {
	s := generateUserID()
	if len(s) != 16 {
		t.Errorf("generateUserID() length = %d, want 16", len(s))
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("generateUserID() contains invalid char: %c", c)
		}
	}
}

func TestSign(t *testing.T) {
	sig, err := sign("https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0")
	if err != nil {
		t.Fatalf("sign() error: %v", err)
	}
	if !strings.HasPrefix(sig, "MSTranslatorAndroidApp::") {
		t.Errorf("sign() = %q, want prefix 'MSTranslatorAndroidApp::'", sig)
	}
	parts := strings.Split(sig, "::")
	if len(parts) != 4 {
		t.Errorf("sign() parts = %d, want 4", len(parts))
	}
	if parts[0] != "MSTranslatorAndroidApp" {
		t.Errorf("sign() parts[0] = %q", parts[0])
	}
	if !strings.HasSuffix(parts[2], "gmt") {
		t.Errorf("sign() parts[2] = %q, want suffix 'gmt'", parts[2])
	}
	if len(parts[3]) != 32 {
		t.Errorf("sign() parts[3] length = %d, want 32", len(parts[3]))
	}
}
