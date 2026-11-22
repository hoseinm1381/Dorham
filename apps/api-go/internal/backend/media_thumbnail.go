package backend

import (
	"bytes"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"strconv"

	_ "github.com/gen2brain/webp"
)

func attachmentThumbnail(r *Request, file *os.File) any {
	_, err := file.Seek(0, 0)
	mediaMust(err)
	info, _, err := image.DecodeConfig(file)
	Check(err == nil && info.Width > 0 && info.Height > 0 && int64(info.Width)*int64(info.Height) <= 16000000, 415, "PREVIEW_UNSUPPORTED", "A small preview is unavailable.")
	_, err = file.Seek(0, 0)
	mediaMust(err)
	source, _, err := image.Decode(file)
	Check(err == nil, 415, "PREVIEW_UNSUPPORTED", "A small preview is unavailable.")
	largest := max(384, info.Width, info.Height)
	width, height := max(1, info.Width*384/largest), max(1, info.Height*384/largest)
	thumb := image.NewRGBA(image.Rect(0, 0, width, height))
	bounds := source.Bounds()
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			thumb.Set(x, y, source.At(bounds.Min.X+x*bounds.Dx()/width, bounds.Min.Y+y*bounds.Dy()/height))
		}
	}
	var payload bytes.Buffer
	mediaMust(jpeg.Encode(&payload, thumb, &jpeg.Options{Quality: 68}))
	r.Header("Content-Type", "image/jpeg")
	r.Header("Cache-Control", "private, no-store")
	r.Header("Content-Length", strconv.Itoa(payload.Len()))
	r.W.WriteHeader(200)
	if r.R.Method != "HEAD" {
		_, _ = r.W.Write(payload.Bytes())
	}
	return nil
}
