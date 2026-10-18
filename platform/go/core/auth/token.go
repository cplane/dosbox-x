package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Claims is what an access token carries. Nothing here is secret — a JWT is
// signed, not encrypted — so it holds only what a service needs to authorize
// a request without a database round trip.
type Claims struct {
	Role Role `json:"role"`
	jwt.RegisteredClaims
}

// Signer mints access tokens. Only services/auth holds one; everyone else
// verifies with the public half.
type Signer struct {
	key    *rsa.PrivateKey
	issuer string
}

func NewSigner(key *rsa.PrivateKey, issuer string) *Signer {
	return &Signer{key: key, issuer: issuer}
}

func (s *Signer) Sign(identity Identity, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := Claims{
		Role: identity.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   identity.Id.String(),
			Issuer:    s.issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	// The username rides along so a client can render "signed in as X"
	// without a second call; it is not authoritative for anything.
	claims.ID = identity.Username

	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(s.key)
	if err != nil {
		return "", fmt.Errorf("signing access token: %w", err)
	}
	return token, nil
}

func (s *Signer) PublicKeyPEM() ([]byte, error) {
	return MarshalPublicKey(&s.key.PublicKey)
}

// Verifier answers "who is this" for a token, without talking to anyone.
type Verifier interface {
	Verify(token string) (Identity, error)
}

type keyVerifier struct {
	key    *rsa.PublicKey
	issuer string
}

// NewVerifier verifies against a public key already in hand.
func NewVerifier(key *rsa.PublicKey, issuer string) Verifier {
	return &keyVerifier{key: key, issuer: issuer}
}

func (v *keyVerifier) Verify(raw string) (Identity, error) {
	if raw == "" {
		return Identity{}, ErrNoToken
	}

	claims := &Claims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		// Pinning the method is what stops the "alg: none" and
		// RS256-verified-as-HMAC families of forgery.
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", t.Header["alg"])
		}
		return v.key, nil
	}, jwt.WithIssuer(v.issuer), jwt.WithExpirationRequired())
	if err != nil {
		return Identity{}, ErrInvalidToken
	}

	id, err := uuid.Parse(claims.Subject)
	if err != nil {
		return Identity{}, ErrInvalidToken
	}
	role := claims.Role
	if !role.Valid() {
		role = RolePlayer
	}
	return Identity{Id: id, Username: claims.ID, Role: role}, nil
}

// LoadOrGenerateRSAKeyPair reads the signing key, creating one on first boot.
//
// The key must outlive the pod: regenerating it invalidates every access
// token in the wild, signing everybody out. That is why it lives on a volume
// and why the auth deployment is pinned to one replica.
func LoadOrGenerateRSAKeyPair(privatePath, publicPath string) (*rsa.PrivateKey, error) {
	if body, err := os.ReadFile(privatePath); err == nil {
		key, err := parsePrivateKey(body)
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", privatePath, err)
		}
		return key, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading %s: %w", privatePath, err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generating signing key: %w", err)
	}

	for path, body := range map[string][]byte{
		privatePath: pem.EncodeToMemory(&pem.Block{
			Type: "PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key),
		}),
	} {
		if err := writeKey(path, body, 0o600); err != nil {
			return nil, err
		}
	}

	pub, err := MarshalPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	if err := writeKey(publicPath, pub, 0o644); err != nil {
		return nil, err
	}
	return key, nil
}

func writeKey(path string, body []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating key directory: %w", err)
	}
	if err := os.WriteFile(path, body, mode); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

func parsePrivateKey(body []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(body)
	if block == nil {
		return nil, fmt.Errorf("no PEM block found")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing private key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("signing key is not RSA")
	}
	return key, nil
}

func MarshalPublicKey(key *rsa.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshalling public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

func ParsePublicKeyPEM(body []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(body)
	if block == nil {
		return nil, fmt.Errorf("no PEM block found")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing public key: %w", err)
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("public key is not RSA")
	}
	return key, nil
}
