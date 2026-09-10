# Wrecked. The same brass as win.rb, walked downwards instead of up, and every
# note sags a semitone as it dies — nothing here is allowed to land on pitch.
# The sub gives out at the bottom and the pressure bleeds away to nothing.
use_random_seed 6666

with_fx :level, amp: 0.85 do
  with_fx :reverb, room: 0.75, mix: 0.34 do
    [:e4, :c4, :gs3, :e3].each do |n|
      use_synth :dsaw
      s = play n, note_slide: 0.3, detune: 0.16, attack: 0.01, sustain: 0.1, release: 0.3, cutoff: 86, amp: 0.6
      control s, note: note(n) - 1
      sleep 0.17
    end

    use_synth :subpulse
    s = play :e2, note_slide: 0.7, attack: 0.02, release: 0.9, amp: 0.7
    control s, note: note(:e2) - 12

    with_fx :rbpf, centre: 86, centre_slide: 0.9, res: 0.5 do |f|
      control f, centre: 56
      use_synth :pnoise
      play 60, attack: 0.1, release: 0.9, cutoff: 108, amp: 0.6
    end
  end
end
