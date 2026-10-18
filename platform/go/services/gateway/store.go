package gateway

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

// Box is a user's dos-box: a C: folder on the shared volume that a pod
// can be started on. Whether it is running is the cluster's business (a
// pod exists), not a column, so the two can never disagree.
type Box struct {
	ID           uuid.UUID `json:"id"`
	Owner        uuid.UUID `json:"-"`
	OwnerName    string    `json:"owner"`
	Name         string    `json:"name"`
	CreatedAt    time.Time `json:"createdAt"`
	LastActiveAt time.Time `json:"lastActiveAt"`
	DiskLimitMB  int       `json:"diskLimitMB"`
	UsedBytes    int64     `json:"usedBytes"`
}

type Store interface {
	ListBoxes(ctx context.Context, owner uuid.UUID) ([]Box, error)
	AllBoxes(ctx context.Context) ([]Box, error)
	GetBox(ctx context.Context, id uuid.UUID) (*Box, error) // ErrNotFound
	CreateBox(ctx context.Context, b *Box) error
	DeleteBox(ctx context.Context, id uuid.UUID) error
	Touch(ctx context.Context, id uuid.UUID, at time.Time) error
	SetUsage(ctx context.Context, id uuid.UUID, used int64) error
}

//go:embed migration/*.sql
var migrations embed.FS

// The auth service migrates the same database with its own version table
// (auth_db_version); goose's table name is a package global, so each
// service names its own.
const versionTable = "gateway_db_version"

type pgStore struct{ db *sql.DB }

func OpenStore(ctx context.Context, url string) (Store, *sql.DB, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, nil, fmt.Errorf("opening postgres: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, nil, fmt.Errorf("connecting to postgres: %w", err)
	}
	goose.SetBaseFS(migrations)
	goose.SetTableName(versionTable)
	if err := goose.SetDialect("postgres"); err != nil {
		db.Close()
		return nil, nil, err
	}
	if err := goose.UpContext(ctx, db, "migration"); err != nil {
		db.Close()
		return nil, nil, fmt.Errorf("running migrations: %w", err)
	}
	return &pgStore{db}, db, nil
}

const boxCols = `id, owner, owner_name, name, created_at, last_active_at, disk_limit_mb, used_bytes`

func scanBoxes(rows *sql.Rows) ([]Box, error) {
	defer rows.Close()
	out := []Box{}
	for rows.Next() {
		var b Box
		if err := rows.Scan(&b.ID, &b.Owner, &b.OwnerName, &b.Name, &b.CreatedAt, &b.LastActiveAt, &b.DiskLimitMB, &b.UsedBytes); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *pgStore) ListBoxes(ctx context.Context, owner uuid.UUID) ([]Box, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+boxCols+` FROM box WHERE owner = $1 ORDER BY created_at`, owner)
	if err != nil {
		return nil, err
	}
	return scanBoxes(rows)
}

func (s *pgStore) AllBoxes(ctx context.Context) ([]Box, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+boxCols+` FROM box ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	return scanBoxes(rows)
}

func (s *pgStore) GetBox(ctx context.Context, id uuid.UUID) (*Box, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+boxCols+` FROM box WHERE id = $1`, id)
	if err != nil {
		return nil, err
	}
	bs, err := scanBoxes(rows)
	if err != nil {
		return nil, err
	}
	if len(bs) == 0 {
		return nil, ErrNotFound
	}
	return &bs[0], nil
}

func (s *pgStore) CreateBox(ctx context.Context, b *Box) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO box (`+boxCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		b.ID, b.Owner, b.OwnerName, b.Name, b.CreatedAt, b.LastActiveAt, b.DiskLimitMB, b.UsedBytes)
	return err
}

func (s *pgStore) DeleteBox(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM box WHERE id = $1`, id)
	return err
}

func (s *pgStore) Touch(ctx context.Context, id uuid.UUID, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE box SET last_active_at = GREATEST(last_active_at, $2) WHERE id = $1`, id, at)
	return err
}

func (s *pgStore) SetUsage(ctx context.Context, id uuid.UUID, used int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE box SET used_bytes = $2 WHERE id = $1`, id, used)
	return err
}

// memStore is the in-memory Store the tests use.
type memStore struct {
	mu    sync.Mutex
	boxes map[uuid.UUID]Box
}

func newMemStore() *memStore { return &memStore{boxes: map[uuid.UUID]Box{}} }

func (m *memStore) ListBoxes(_ context.Context, owner uuid.UUID) ([]Box, error) {
	all, _ := m.AllBoxes(context.Background())
	out := []Box{}
	for _, b := range all {
		if b.Owner == owner {
			out = append(out, b)
		}
	}
	return out, nil
}

func (m *memStore) AllBoxes(context.Context) ([]Box, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Box{}
	for _, b := range m.boxes {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (m *memStore) GetBox(_ context.Context, id uuid.UUID) (*Box, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.boxes[id]
	if !ok {
		return nil, ErrNotFound
	}
	return &b, nil
}

func (m *memStore) CreateBox(_ context.Context, b *Box) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.boxes[b.ID]; ok {
		return errors.New("duplicate box")
	}
	m.boxes[b.ID] = *b
	return nil
}

func (m *memStore) DeleteBox(_ context.Context, id uuid.UUID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.boxes, id)
	return nil
}

func (m *memStore) Touch(_ context.Context, id uuid.UUID, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.boxes[id]; ok && at.After(b.LastActiveAt) {
		b.LastActiveAt = at
		m.boxes[id] = b
	}
	return nil
}

func (m *memStore) SetUsage(_ context.Context, id uuid.UUID, used int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.boxes[id]; ok {
		b.UsedBytes = used
		m.boxes[id] = b
	}
	return nil
}
