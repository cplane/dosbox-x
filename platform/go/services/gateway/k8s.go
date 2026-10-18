package gateway

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Kube is the little of the Kubernetes API the gateway needs: create, get,
// list and delete pods in its own namespace. A plain REST client over the
// pod's service account rather than client-go, which would be most of the
// binary for four calls.
type Kube interface {
	CreatePod(ctx context.Context, pod *Pod) error
	GetPod(ctx context.Context, name string) (*Pod, error) // ErrNotFound if absent
	ListPods(ctx context.Context, selector string) ([]Pod, error)
	DeletePod(ctx context.Context, name string) error // nil if already gone
}

var ErrNotFound = errors.New("not found")

// Pod is the subset of v1.Pod the gateway reads and writes; Spec is kept as
// raw JSON-able maps so the pod template stays readable in pods.go.
type Pod struct {
	APIVersion string         `json:"apiVersion,omitempty"`
	Kind       string         `json:"kind,omitempty"`
	Metadata   ObjectMeta     `json:"metadata"`
	Spec       map[string]any `json:"spec,omitempty"`
	Status     PodStatus      `json:"status,omitempty"`
}

type ObjectMeta struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace,omitempty"`
	Labels            map[string]string `json:"labels,omitempty"`
	Annotations       map[string]string `json:"annotations,omitempty"`
	CreationTimestamp time.Time         `json:"creationTimestamp,omitempty"`
	DeletionTimestamp *time.Time        `json:"deletionTimestamp,omitempty"`
}

type PodStatus struct {
	Phase      string `json:"phase,omitempty"`
	PodIP      string `json:"podIP,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Conditions []struct {
		Type   string `json:"type"`
		Status string `json:"status"`
	} `json:"conditions,omitempty"`
	ContainerStatuses []struct {
		Name  string `json:"name"`
		Ready bool   `json:"ready"`
		State struct {
			Waiting *struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"waiting,omitempty"`
		} `json:"state"`
	} `json:"containerStatuses,omitempty"`
}

// Ready reports the pod's Ready condition (the stream sidecar's readiness
// probe passes once DOSBox-X frames flow).
func (p *Pod) Ready() bool {
	for _, c := range p.Status.Conditions {
		if c.Type == "Ready" {
			return c.Status == "True"
		}
	}
	return false
}

type kubeREST struct {
	base      string // https://host:port/api/v1/namespaces/<ns>/pods
	token     string
	client    *http.Client
	namespace string
}

const saDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// NewInClusterKube uses the pod's service account. namespace "" means the
// pod's own namespace.
func NewInClusterKube(namespace string) (Kube, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" {
		return nil, errors.New("not running in a cluster (KUBERNETES_SERVICE_HOST unset)")
	}
	token, err := os.ReadFile(saDir + "/token")
	if err != nil {
		return nil, err
	}
	ca, err := os.ReadFile(saDir + "/ca.crt")
	if err != nil {
		return nil, err
	}
	if namespace == "" {
		ns, err := os.ReadFile(saDir + "/namespace")
		if err != nil {
			return nil, err
		}
		namespace = strings.TrimSpace(string(ns))
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(ca)
	return &kubeREST{
		base:      fmt.Sprintf("https://%s/api/v1/namespaces/%s/pods", strings.Join([]string{host, port}, ":"), namespace),
		token:     strings.TrimSpace(string(token)),
		namespace: namespace,
		client: &http.Client{
			Timeout:   15 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
		},
	}, nil
}

func (k *kubeREST) do(ctx context.Context, method, url string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := k.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode >= 300 {
		var st struct{ Message string }
		_ = json.Unmarshal(data, &st)
		return fmt.Errorf("kubernetes %s %s: %s %s", method, url, resp.Status, st.Message)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (k *kubeREST) CreatePod(ctx context.Context, pod *Pod) error {
	pod.APIVersion, pod.Kind, pod.Metadata.Namespace = "v1", "Pod", k.namespace
	return k.do(ctx, http.MethodPost, k.base, pod, nil)
}

func (k *kubeREST) GetPod(ctx context.Context, name string) (*Pod, error) {
	var p Pod
	if err := k.do(ctx, http.MethodGet, k.base+"/"+url.PathEscape(name), nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (k *kubeREST) ListPods(ctx context.Context, selector string) ([]Pod, error) {
	var list struct{ Items []Pod }
	if err := k.do(ctx, http.MethodGet, k.base+"?labelSelector="+url.QueryEscape(selector), nil, &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (k *kubeREST) DeletePod(ctx context.Context, name string) error {
	// A short grace period: DOSBox-X has nothing to flush (C: is a host
	// directory written through), so there's no reason to hold a slot.
	err := k.do(ctx, http.MethodDelete, k.base+"/"+url.PathEscape(name)+"?gracePeriodSeconds=5", nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}
