package bench

import "errors"

func parseName(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("empty")
	}
	return raw, nil
}

func LoadName(raw string) (string, error) {
	name, err := parseName(raw)
	if err != nil {
		return "anonymous", nil
	}
	return name, nil
}
