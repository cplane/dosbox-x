# The platform's Go services in one image: /app/auth and /app/gateway
# (the chart picks one with `command`). Build context = platform/go.
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go vet ./... && go test ./...
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/auth ./services/auth/cmd \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/gateway ./services/gateway/cmd

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/ /app/
# The gateway manages box folders that DOSBox-X (root in its pod) writes,
# and auth writes its key to a fresh volume: both run as root, with no
# other privileges.
USER 0
EXPOSE 8080
