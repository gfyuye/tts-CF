package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// ============ 常量 ============

var tokenPriority = []struct {
	Region   string
	Priority int
}{
	{"southeastasia", 1},
	{"eastus", 2},
	{"westeurope", 3},
	{"westus2", 4},
	{"eastasia", 5},
}

const topPriority = 5

const signKeyBase64 = "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="

const dynamicTokenTimeout = 1 * time.Second
const maxAttempts = 3

// ============ HTTP Client 单例 ============

var httpClient = &http.Client{
	Timeout: dynamicTokenTimeout,
	Transport: &http.Transport{
		MaxIdleConns:        10,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     30 * time.Second,
		TLSHandshakeTimeout: 5 * time.Second,
	},
}

// ============ 类型 ============

type tokenResult struct {
	region   string
	token    string
	expiry   int64
	priority int
}

type TokenResponse struct {
	Success          bool   `json:"success"`
	Region           string `json:"region,omitempty"`
	Token            string `json:"token,omitempty"`
	Expiry           int64  `json:"expiry,omitempty"`
	Priority         int    `json:"priority,omitempty"`
	RemainingMinutes int    `json:"remainingMinutes,omitempty"`
	RemainingSeconds int    `json:"remainingSeconds,omitempty"`
	Error            string `json:"error,omitempty"`
	Message          string `json:"message,omitempty"`
	Timestamp        string `json:"timestamp,omitempty"`
}

// ============ 工具函数 ============

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b)
}

func generateUserID() string {
	const chars = "abcdef0123456789"
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}

func dateFormat() string {
	s := time.Now().UTC().Format("Mon, 02 Jan 2006 15:04:05")
	return strings.ToLower(s) + " gmt"
}

func getPriority(region string) int {
	for _, p := range tokenPriority {
		if p.Region == region {
			return p.Priority
		}
	}
	return 99
}

func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' ||
			c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

func decodeJWTPayload(token string) (map[string]interface{}, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid jwt")
	}
	payload := parts[1]
	payload = strings.ReplaceAll(payload, "-", "+")
	payload = strings.ReplaceAll(payload, "_", "/")
	if m := len(payload) % 4; m != 0 {
		payload += strings.Repeat("=", 4-m)
	}
	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func sign(urlStr string) (string, error) {
	idx := strings.Index(urlStr, "://")
	if idx < 0 {
		return "", fmt.Errorf("invalid url")
	}
	urlPart := urlStr[idx+3:]
	encodedURL := encodeURIComponent(urlPart)

	uuidStr := uuid()
	formattedDate := dateFormat()
	bytesToSign := strings.ToLower(
		fmt.Sprintf("MSTranslatorAndroidApp%s%s%s", encodedURL, formattedDate, uuidStr),
	)

	key, err := base64.StdEncoding.DecodeString(signKeyBase64)
	if err != nil {
		return "", err
	}

	h := hmac.New(sha256.New, key)
	h.Write([]byte(bytesToSign))
	sigBase64 := base64.StdEncoding.EncodeToString(h.Sum(nil))

	return fmt.Sprintf("MSTranslatorAndroidApp::%s::%s::%s", sigBase64, formattedDate, uuidStr), nil
}

// ============ 获取动态 token ============

func getDynamicToken(ctx context.Context) (*tokenResult, error) {
	endpointURL := "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0"

	sig, err := sign(endpointURL)
	if err != nil {
		return nil, fmt.Errorf("sign failed: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpointURL, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Accept-Language", "zh-Hans")
	req.Header.Set("X-ClientVersion", "4.0.530a 5fe1dc6c")
	req.Header.Set("X-UserId", generateUserID())
	req.Header.Set("X-HomeGeographicRegion", "zh-Hans-CN")
	req.Header.Set("X-ClientTraceId", uuid())
	req.Header.Set("X-MT-Signature", sig)
	req.Header.Set("User-Agent", "okhttp/4.5.0")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", "0")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	var data struct {
		T string `json:"t"`
		R string `json:"r"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("json unmarshal failed: %w", err)
	}

	actualRegion := data.R
	if actualRegion == "" {
		actualRegion = "unknown"
	}
	tokenExpiry := time.Now().Add(20 * time.Minute).UnixMilli()

	if payload, err := decodeJWTPayload(data.T); err == nil {
		if exp, ok := payload["exp"].(float64); ok {
			tokenExpiry = int64(exp) * 1000
		}
		if aud, ok := payload["aud"].(string); ok {
			const prefix = "urn:ms.speechservices."
			if strings.HasPrefix(aud, prefix) {
				actualRegion = strings.TrimPrefix(aud, prefix)
			}
		}
	}

	return &tokenResult{
		region:   actualRegion,
		token:    data.T,
		expiry:   tokenExpiry,
		priority: getPriority(actualRegion),
	}, nil
}

// ============ 刷新 token ============

func refreshToken(ctx context.Context, reqID string) TokenResponse {
	log.Printf("[%s] 🔄 开始获取token（前%d级优先）", reqID, topPriority)

	var lastToken *tokenResult

	for attempt := 0; attempt < maxAttempts; attempt++ {
		select {
		case <-ctx.Done():
			log.Printf("[%s] ⚠️ 请求已取消，停止获取", reqID)
			return TokenResponse{
				Success:   false,
				Error:     "request canceled",
				Timestamp: time.Now().UTC().Format(time.RFC3339),
			}
		default:
		}

		tokenData, err := getDynamicToken(ctx)
		if err != nil {
			if ctx.Err() != nil {
				log.Printf("[%s] ⚠️ 请求已取消（第%d次尝试），停止获取", reqID, attempt+1)
				return TokenResponse{
					Success:   false,
					Error:     "request canceled",
					Timestamp: time.Now().UTC().Format(time.RFC3339),
				}
			}
			log.Printf("[%s]   第%d次: 获取失败: %v", reqID, attempt+1, err)
			continue
		}

		lastToken = tokenData

		remainingMs := tokenData.expiry - time.Now().UnixMilli()
		if remainingMs < 0 {
			remainingMs = 0
		}
		remainingMinutes := int(remainingMs / 60000)
		remainingSeconds := int((remainingMs % 60000) / 1000)
		if remainingSeconds > 59 {
			remainingSeconds = 59
		}

		if tokenData.priority <= topPriority {
			log.Printf("[%s]   ✅ 获取token: %s(P%d, %d分%d秒)", reqID, tokenData.region, tokenData.priority, remainingMinutes, remainingSeconds)
			return TokenResponse{
				Success:          true,
				Region:           tokenData.region,
				Token:            tokenData.token,
				Expiry:           tokenData.expiry,
				Priority:         tokenData.priority,
				RemainingMinutes: remainingMinutes,
				RemainingSeconds: remainingSeconds,
			}
		}

		log.Printf("[%s]   第%d次: 弃用 %s(P%d)，不在前%d级", reqID, attempt+1, tokenData.region, tokenData.priority, topPriority)
	}

	if lastToken != nil {
		remainingMs := lastToken.expiry - time.Now().UnixMilli()
		if remainingMs < 0 {
			remainingMs = 0
		}
		remainingMinutes := int(remainingMs / 60000)
		remainingSeconds := int((remainingMs % 60000) / 1000)
		if remainingSeconds > 59 {
			remainingSeconds = 59
		}

		log.Printf("[%s]   ⚠️ %d次后返回最后token: %s(P%d, %d分%d秒)", reqID, maxAttempts, lastToken.region, lastToken.priority, remainingMinutes, remainingSeconds)

		return TokenResponse{
			Success:          true,
			Region:           lastToken.region,
			Token:            lastToken.token,
			Expiry:           lastToken.expiry,
			Priority:         lastToken.priority,
			RemainingMinutes: remainingMinutes,
			RemainingSeconds: remainingSeconds,
		}
	}

	log.Printf("[%s] ❌ %d次尝试后仍无可用token", reqID, maxAttempts)
	return TokenResponse{
		Success:   false,
		Error:     "未获取可用的token",
		Message:   "无法从微软接口获取 token",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}
