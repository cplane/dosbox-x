package main

import (
	"os"

	"github.com/sirupsen/logrus"
	"go.uber.org/fx"

	auth "dosbox/services/auth"
)

func main() {
	logrus.SetOutput(os.Stdout)
	logrus.SetLevel(logrus.DebugLevel)
	logrus.SetFormatter(&logrus.TextFormatter{
		DisableTimestamp:       true,
		DisableLevelTruncation: true,
		ForceColors:            true,
	})

	fx.New(auth.Module, fx.Logger(logrus.StandardLogger())).Run()
}
