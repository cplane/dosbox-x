# dos-box stream sidecar. Build context = platform/stream (see platform/build.sh).
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stream .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/stream /stream
# Must be able to open DOSBox-X's /dev/shm files (created by root in the
# dosbox container, mode 0644): run as root, no other privileges needed.
USER 0
EXPOSE 8080
ENTRYPOINT ["/stream"]
