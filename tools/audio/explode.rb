# A boiler goes off. The loudest thing in the set and the one everything else
# is balanced against: pressure wave, wallop, debris falling away through a
# closing lowpass, then the long steam release out of the rupture.
# Chain-reaction kills fire these in clusters, so the runtime thins the tail on
# any blast that lands within 90 ms of the last one.
use_random_seed 5504

with_fx :level, amp: 1.0 do
  with_fx :reverb, room: 0.62, mix: 0.3 do
    # Pressure wave: a sine dropping two octaves in a third of a second.
    use_synth :sine
    s = play 38, note_slide: 0.3, attack: 0.004, release: 0.38, amp: 1.0
    control s, note: 22

    # The wallop itself. Both samples run for seconds untouched, so both are
    # cut to their front end — an explicit sustain is what truncates a sample
    # in Sonic Pi; `release:` alone would keep the whole thing and just fade it.
    sample :bd_boom, rate: 0.8, attack: 0.001, sustain: 0.15, release: 0.45, amp: 0.9
    sample :misc_cineboom, rate: 1.5, attack: 0.005, sustain: 0.1, release: 0.5, amp: 0.5

    # Debris: broadband, closing down as it falls.
    with_fx :lpf, cutoff: 120, cutoff_slide: 0.35 do |f|
      control f, cutoff: 62
      use_synth :cnoise
      play 60, attack: 0.002, release: 0.42, amp: 0.85
    end

    sleep 0.08
    # Plating cracking off.
    sample :hat_metal, rate: 1.1, attack: 0.001, sustain: 0.03, release: 0.16, amp: 0.5

    # The rupture: steam sweeping down out of the blast.
    with_fx :rbpf, centre: 98, centre_slide: 0.5, res: 0.5 do |f|
      control f, centre: 68
      use_synth :bnoise
      play 60, attack: 0.05, release: 0.55, cutoff: 118, amp: 0.9
    end
  end
end
