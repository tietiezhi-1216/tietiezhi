.PHONY: build run test clean

build:
	go build -o bin/tietiezhi ./cmd/server

run: build
	./bin/tietiezhi -c configs/config.yaml

test:
	go test ./...

clean:
	rm -rf bin/
