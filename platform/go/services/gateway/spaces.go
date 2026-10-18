package gateway

import (
	"context"
	"errors"
	"fmt"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// spaces is the catalog's master copy store: a private DO Spaces bucket,
// spoken to through the S3 API.
type spaces struct {
	client *minio.Client
	bucket string
}

// NewSpaces connects to the bucket, creating it if needed. Without a key it
// returns nil: the catalog then lives on the volume only.
func NewSpaces(ctx context.Context, cfg *Config) (Blob, error) {
	if cfg.SpacesKey == "" || cfg.SpacesSecret == "" || cfg.SpacesBucket == "" {
		return nil, nil
	}
	client, err := minio.New(cfg.SpacesEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.SpacesKey, cfg.SpacesSecret, ""),
		Secure: true,
		Region: "us-east-1", // what DO documents for S3 clients; the endpoint picks the region
	})
	if err != nil {
		return nil, fmt.Errorf("spaces client: %w", err)
	}
	ok, err := client.BucketExists(ctx, cfg.SpacesBucket)
	if err != nil {
		return nil, fmt.Errorf("spaces bucket %s: %w", cfg.SpacesBucket, err)
	}
	if !ok {
		if err := client.MakeBucket(ctx, cfg.SpacesBucket, minio.MakeBucketOptions{Region: "us-east-1"}); err != nil {
			return nil, fmt.Errorf("creating spaces bucket %s: %w", cfg.SpacesBucket, err)
		}
	}
	return &spaces{client: client, bucket: cfg.SpacesBucket}, nil
}

func (s *spaces) Put(ctx context.Context, key, file string) error {
	_, err := s.client.FPutObject(ctx, s.bucket, key, file, minio.PutObjectOptions{ContentType: "application/zip"})
	return err
}

func (s *spaces) Get(ctx context.Context, key, file string) error {
	return s.client.FGetObject(ctx, s.bucket, key, file, minio.GetObjectOptions{})
}

func (s *spaces) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	var resp minio.ErrorResponse
	if errors.As(err, &resp) && (resp.Code == "NoSuchKey" || resp.StatusCode == 404) {
		return false, nil
	}
	return err == nil, err
}

func (s *spaces) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}
