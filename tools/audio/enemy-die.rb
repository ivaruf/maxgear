# A machine comes apart: the frame gives, three pieces of plate hit the road,
# then the pressure lets go. Fires in clusters when a wave collapses, so the
# scrap thins out as it falls and the whole thing is over inside half a second.
use_random_seed 3391

with_fx :level, amp: 0.7 do
  with_fx :reverb, room: 0.5, mix: 0.22 do
    # The boiler note drops out of the frame as it buckles.
    use_synth :dsaw
    s = play :e3, note_slide: 0.16, detune: 0.2, attack: 0.005, release: 0.22, cutoff: 95, amp: 0.75
    control s, note: :b1

    3.times do |i|
      sample :hat_metal, rate: rrand(0.7, 1.2) - i * 0.1,
             attack: 0.001, sustain: 0.03, release: 0.14, amp: 0.5 - i * 0.12
      sleep rrand(0.035, 0.06)
    end

    # Steam venting out of the wreck.
    with_fx :rbpf, centre: 95, centre_slide: 0.3, res: 0.55 do |f|
      control f, centre: 70
      use_synth :bnoise
      play 60, attack: 0.02, release: 0.3, cutoff: 115, amp: 0.8
    end
  end
end
