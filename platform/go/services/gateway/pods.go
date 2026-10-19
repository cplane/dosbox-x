package gateway

import (
	"fmt"
	"strconv"

	"github.com/google/uuid"
)

// Config is the gateway's environment.
type Config struct {
	Port        int    `env:"HTTP_SERVICE_PORT" envDefault:"8080"`
	PostgresURL string `env:"GATEWAY_POSTGRES_URL"`
	AuthURL     string `env:"AUTH_SERVER_URL" envDefault:"http://dosbox-auth:8080/auth"`
	AuthIssuer  string `env:"AUTH_TOKEN_ISSUER" envDefault:"dosbox-auth"`

	Namespace string `env:"POD_NAMESPACE"`
	// The shared volume as the gateway sees it, and its claim name for box
	// pods; each box's folder is <BoxesDir>/<id> = subPath <id> of the claim.
	BoxesDir string `env:"BOXES_DIR" envDefault:"/boxes"`
	BoxesPVC string `env:"BOXES_PVC" envDefault:"dosbox-boxes"`

	DosboxImage     string `env:"BOX_DOSBOX_IMAGE" envDefault:"registry.digitalocean.com/container-registry-ams3/dosbox-x:latest"`
	StreamImage     string `env:"BOX_STREAM_IMAGE" envDefault:"registry.digitalocean.com/container-registry-ams3/dosbox-stream:latest"`
	PullSecret      string `env:"BOX_PULL_SECRET" envDefault:"container-registry-ams3"`
	ImagePullPolicy string `env:"BOX_IMAGE_PULL_POLICY" envDefault:"IfNotPresent"`

	IdleMinutes       int `env:"BOX_IDLE_MINUTES" envDefault:"15"`
	MaxBoxesPerUser   int `env:"MAX_BOXES_PER_USER" envDefault:"3"`
	MaxRunningPerUser int `env:"MAX_RUNNING_PER_USER" envDefault:"1"`
	MaxRunningTotal   int `env:"MAX_RUNNING_TOTAL" envDefault:"8"`
	DiskLimitMB       int `env:"BOX_DISK_LIMIT_MB" envDefault:"500"`

	// The stream sidecar's port in a box pod (tests point it elsewhere).
	BoxPort int `env:"BOX_PORT" envDefault:"8080"`

	// The catalog (catalog.go): the largest unpacked item, and its master
	// copies in DO Spaces (all three set, or none: volume only).
	CatalogMaxItemMB int    `env:"CATALOG_MAX_ITEM_MB" envDefault:"400"`
	SpacesEndpoint   string `env:"SPACES_ENDPOINT" envDefault:"ams3.digitaloceanspaces.com"`
	SpacesBucket     string `env:"SPACES_BUCKET"`
	SpacesKey        string `env:"SPACES_KEY"`
	SpacesSecret     string `env:"SPACES_SECRET"`
	// Where archive.org imports come from (tests point it elsewhere).
	ArchiveOrgURL string `env:"ARCHIVE_ORG_URL" envDefault:"https://archive.org"`
}

// Labels on box pods. storageLabel is shared with the gateway pod: every pod
// carrying it must run on the same node, because the shared volume is a
// DigitalOcean block volume that attaches to one node at a time.
const (
	appLabel     = "app.kubernetes.io/name"
	appBox       = "dosbox-box"
	boxLabel     = "dosbox/box"
	ownerLabel   = "dosbox/owner"
	storageLabel = "dosbox/storage"
	storageValue = "boxes"
)

func podName(id uuid.UUID) string { return "box-" + id.String() }

// boxPod is the pod for one running box: DOSBox-X headless plus the stream
// sidecar, sharing /dev/shm (Game Link), with the box's folder as /data
// (C: = /data/c). DOS sees the remaining disk allowance as free space.
func boxPod(cfg *Config, b *Box, freeMB int) *Pod {
	if freeMB < 1 {
		freeMB = 1
	}
	id := b.ID.String()
	return &Pod{
		Metadata: ObjectMeta{
			Name: podName(b.ID),
			Labels: map[string]string{
				appLabel:     appBox,
				boxLabel:     id,
				ownerLabel:   b.Owner.String(),
				storageLabel: storageValue,
			},
			Annotations: map[string]string{"dosbox/name": b.Name, "dosbox/owner-name": b.OwnerName},
		},
		Spec: map[string]any{
			"restartPolicy":                 "Never",
			"automountServiceAccountToken":  false,
			"enableServiceLinks":            false,
			"terminationGracePeriodSeconds": 5,
			"imagePullSecrets":              []any{map[string]any{"name": cfg.PullSecret}},
			"affinity": map[string]any{
				"podAffinity": map[string]any{
					"requiredDuringSchedulingIgnoredDuringExecution": []any{map[string]any{
						"labelSelector": map[string]any{"matchLabels": map[string]any{storageLabel: storageValue}},
						"topologyKey":   "kubernetes.io/hostname",
					}},
				},
			},
			"containers": []any{
				map[string]any{
					"name":            "dosbox",
					"image":           cfg.DosboxImage,
					"imagePullPolicy": cfg.ImagePullPolicy,
					"args":            b.Machine.DosboxArgs(), // -set section key=value (entrypoint.sh)
					"env":             []any{map[string]any{"name": "C_FREESIZE_MB", "value": strconv.Itoa(freeMB)}},
					"resources": map[string]any{
						"requests": map[string]any{"cpu": "250m", "memory": "128Mi"},
						"limits":   map[string]any{"cpu": "1", "memory": "512Mi"},
					},
					"volumeMounts": []any{
						map[string]any{"name": "data", "mountPath": "/data", "subPath": id},
						map[string]any{"name": "shm", "mountPath": "/dev/shm"},
					},
				},
				map[string]any{
					"name":            "stream",
					"image":           cfg.StreamImage,
					"imagePullPolicy": cfg.ImagePullPolicy,
					"env":             []any{map[string]any{"name": "DATA_DIR", "value": "/data/c"}},
					"ports":           []any{map[string]any{"name": "http", "containerPort": 8080}},
					"readinessProbe": map[string]any{
						"httpGet":       map[string]any{"path": "/healthz", "port": "http"},
						"periodSeconds": 2,
					},
					"resources": map[string]any{
						"requests": map[string]any{"cpu": "100m", "memory": "32Mi"},
						"limits":   map[string]any{"cpu": "1", "memory": "128Mi"},
					},
					"volumeMounts": []any{
						map[string]any{"name": "data", "mountPath": "/data/c", "subPath": id + "/c"},
						map[string]any{"name": "shm", "mountPath": "/dev/shm"},
					},
				},
			},
			"volumes": []any{
				map[string]any{"name": "data", "persistentVolumeClaim": map[string]any{"claimName": cfg.BoxesPVC}},
				map[string]any{"name": "shm", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "64Mi"}},
			},
		},
	}
}

// BoxState is what the API reports for a box.
type BoxState string

const (
	StateStopped  BoxState = "stopped"
	StateStarting BoxState = "starting"
	StateRunning  BoxState = "running"
	StateStopping BoxState = "stopping"
	StateFailed   BoxState = "failed"
)

// podState maps a box pod (nil = none) to a state plus a short reason.
func podState(p *Pod) (BoxState, string) {
	switch {
	case p == nil:
		return StateStopped, ""
	case p.Metadata.DeletionTimestamp != nil:
		return StateStopping, ""
	case p.Status.Phase == "Failed" || p.Status.Phase == "Succeeded":
		return StateFailed, fmt.Sprintf("pod %s %s", p.Status.Phase, p.Status.Reason)
	case p.Status.Phase == "Running" && p.Ready() && p.Status.PodIP != "":
		return StateRunning, ""
	}
	for _, c := range p.Status.ContainerStatuses {
		if w := c.State.Waiting; w != nil && w.Reason != "" && w.Reason != "ContainerCreating" {
			return StateStarting, c.Name + ": " + w.Reason
		}
	}
	return StateStarting, ""
}
