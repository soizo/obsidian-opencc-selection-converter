# Fixed OpenCC dictionary fixtures

`formats.txt` is the hand-authored source. `formats.ocd` and `formats.ocd2` were generated once with the `opencc_dict` target built from the pinned official OpenCC commit `025f371dc76b598d77384fbdab90c937471844d8` (tag `ver.1.4.2`):

```sh
opencc_dict -i formats.txt -o formats.ocd -f text -t ocd
opencc_dict -i formats.txt -o formats.ocd2 -f text -t ocd2
```

SHA-256:

- `formats.txt`: `80becefe9e4185d688d9a0991e3ef1cea575ec9435974ee910546369c2a0b99f`
- `formats.ocd`: `61fb405be9d047b5c4c5ef67ac2ca4e188c019d7e5ae20ccdde62e09e65c8b2c`
- `formats.ocd2`: `7e8ce53b9bbc8ce4b5132fde5931457263ac48e49763026c15701119cb0de732`

These small files verify decoding format support. They are not product dictionaries and are absent from production builds.
