package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func timingSafeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("⚠️ JSON 编码失败: %v", err)
	}
}

func handleGetToken(w http.ResponseWriter, r *http.Request, apiKey string) {
	reqID := uuid()[:8]
	w.Header().Set("X-Request-Id", reqID)

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if apiKey == "" {
		log.Printf("[%s] ❌ 未配置 API_KEY，拒绝所有请求", reqID)
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"success": false,
			"error":   "Server misconfigured: API_KEY not set",
		})
		return
	}

	provided := r.Header.Get("X-API-Key")
	if provided == "" {
		provided = r.URL.Query().Get("api_key")
	}
	provided = strings.TrimSpace(provided)

	if !timingSafeEqual(provided, apiKey) {
		log.Printf("[%s] ❌ API Key 验证失败", reqID)
		writeJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"success": false,
			"error":   "认证失败",
		})
		return
	}

	log.Printf("[%s] 🔑 API Key 验证通过", reqID)

	result := refreshToken(r.Context(), reqID)

	status := http.StatusOK
	if !result.Success {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, result)
}

func main() {
	apiKey := strings.TrimSpace(os.Getenv("API_KEY"))
	port := os.Getenv("PORT")
	if port == "" {
		port = "8788"
	}

	mux := http.NewServeMux()

	tokenHandler := func(w http.ResponseWriter, r *http.Request) {
		handleGetToken(w, r, apiKey)
	}
	mux.HandleFunc("/get-token", tokenHandler)
	mux.HandleFunc("/token", tokenHandler)

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		apiKeyStatus := "missing"
		if apiKey != "" {
			apiKeyStatus = "configured"
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status": "ok",
			"apiKey": apiKeyStatus,
		})
	})

	addr := "0.0.0.0:" + port

	baseCtx, baseCancel := context.WithCancel(context.Background())
	defer baseCancel()

	server := &http.Server{
		Addr:        addr,
		Handler:     mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
		BaseContext: func(net.Listener) context.Context {
			return baseCtx
		},
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		<-sigCh
		log.Printf("🛑 收到停止信号，优雅关闭...")
		baseCancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("⚠️ 优雅关闭失败: %v", err)
		}
	}()

	log.Printf("🚀 token-worker 监听 %s", addr)
	if apiKey == "" {
		log.Printf("   API_KEY: 未配置")
	} else {
		log.Printf("   API_KEY: 已配置")
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("启动失败: %v", err)
	}
	log.Printf("✅ 服务已停止")
}
