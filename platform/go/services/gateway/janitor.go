package gateway

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// Sweep is one janitor pass over the running box pods:
//   - a pod whose box no longer exists is deleted;
//   - a failed pod is deleted after a minute (so its state can be seen), letting
//     the owner start the box again;
//   - a box over its disk allowance is stopped (the soft limit);
//   - a box with nobody watching and no activity for BOX_IDLE_MINUTES is stopped.
//
// Its folder always stays: stopping only frees the pod.
func (s *Server) Sweep(ctx context.Context) {
	pods, err := s.kube.ListPods(ctx, appLabel+"="+appBox)
	if err != nil {
		logrus.WithError(err).Warn("janitor: listing box pods")
		return
	}
	idle := time.Duration(s.cfg.IdleMinutes) * time.Minute
	now := s.now()
	for i := range pods {
		p := &pods[i]
		if p.Metadata.DeletionTimestamp != nil {
			continue
		}
		id, err := uuid.Parse(p.Metadata.Labels[boxLabel])
		b, gerr := s.store.GetBox(ctx, id)
		if err != nil || errors.Is(gerr, ErrNotFound) {
			s.stopPod(ctx, p.Metadata.Name, id, "orphan (box deleted)")
			continue
		} else if gerr != nil {
			logrus.WithError(gerr).Warn("janitor: reading box")
			continue
		}
		st, reason := podState(p)
		if st == StateFailed && now.Sub(p.Metadata.CreationTimestamp) > time.Minute {
			s.stopPod(ctx, p.Metadata.Name, id, "instance failed: "+reason)
			continue
		}
		used := dirUsage(s.cDir(id))
		s.store.SetUsage(ctx, id, used)
		if used > int64(b.DiskLimitMB)<<20 {
			s.stopPod(ctx, p.Metadata.Name, id, fmt.Sprintf("stopped: C: uses %d MB of %d MB", used>>20, b.DiskLimitMB))
			continue
		}
		s.mu.Lock()
		watchers := s.viewers[id]
		s.mu.Unlock()
		last := s.lastActive(b)
		if p.Metadata.CreationTimestamp.After(last) {
			last = p.Metadata.CreationTimestamp
		}
		if watchers == 0 && now.Sub(last) > idle {
			s.stopPod(ctx, p.Metadata.Name, id, fmt.Sprintf("stopped after %d idle minutes", s.cfg.IdleMinutes))
			continue
		}
		s.persistActive(ctx, id)
	}
}

func (s *Server) stopPod(ctx context.Context, name string, id uuid.UUID, why string) {
	if err := s.kube.DeletePod(ctx, name); err != nil {
		logrus.WithError(err).WithField("pod", name).Warn("janitor: deleting pod")
		return
	}
	s.persistActive(ctx, id)
	s.mu.Lock()
	s.stopped[id] = why
	s.mu.Unlock()
	logrus.WithFields(logrus.Fields{"pod": name, "why": why}).Info("janitor stopped box")
}

// RunJanitor sweeps every interval until ctx ends.
func (s *Server) RunJanitor(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Sweep(ctx)
		}
	}
}
