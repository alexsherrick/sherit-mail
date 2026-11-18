//! The unread count drawn for the taskbar button (an overlay icon: unpackaged apps get no numeric badge from Windows) and a
//! dot on the tray icon. Drawn at run time with Segoe UI from the system's own font folder, so there are no image assets
//! and the digits match the rest of Windows; without the font the badge is a plain dot.

use ab_glyph::{point, Font, FontVec, PxScale, ScaleFont};
use std::sync::OnceLock;

pub const RED: [u8; 3] = [0xD9, 0x30, 0x25];

static FONT: OnceLock<Option<FontVec>> = OnceLock::new();

fn font() -> Option<&'static FontVec> {
    FONT.get_or_init(|| {
        let candidates: &[&str] = if cfg!(windows) {
            &[r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"]
        } else {
            &["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
        };
        let dir = std::env::var("WINDIR").map(|w| format!(r"{w}\Fonts\segoeuib.ttf")).ok();
        dir.iter().map(String::as_str).chain(candidates.iter().copied()).find_map(|p| std::fs::read(p).ok().and_then(|b| FontVec::try_from_vec(b).ok()))
    })
    .as_ref()
}

pub struct Rgba {
    pub px: Vec<u8>,
    pub w: u32,
    pub h: u32,
}

impl Rgba {
    fn new(w: u32, h: u32) -> Self {
        Rgba { px: vec![0; (w * h * 4) as usize], w, h }
    }
    /// Source-over blend of a solid colour at coverage `a` (0..1).
    fn blend(&mut self, x: i32, y: i32, rgb: [u8; 3], a: f32) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 || a <= 0.0 {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        let a = a.min(1.0);
        let da = self.px[i + 3] as f32 / 255.0;
        let oa = a + da * (1.0 - a);
        for c in 0..3 {
            let s = rgb[c] as f32 / 255.0;
            let d = self.px[i + c] as f32 / 255.0;
            let o = if oa > 0.0 { (s * a + d * da * (1.0 - a)) / oa } else { 0.0 };
            self.px[i + c] = (o * 255.0).round() as u8;
        }
        self.px[i + 3] = (oa * 255.0).round() as u8;
    }
    /// Punch a hole (alpha × (1 - a)) so the dot reads against any icon.
    fn erase(&mut self, x: i32, y: i32, a: f32) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4 + 3) as usize;
        self.px[i] = (self.px[i] as f32 * (1.0 - a.clamp(0.0, 1.0))).round() as u8;
    }
}

/// Coverage of a pill (a capsule from (x0,cy) to (x1,cy) with radius r) at pixel centre (px,py), anti-aliased over 1 px.
fn pill(px: f32, py: f32, x0: f32, x1: f32, cy: f32, r: f32) -> f32 {
    let cx = px.clamp(x0, x1);
    let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
    (r - d + 0.5).clamp(0.0, 1.0)
}

fn label(n: u32) -> String {
    if n > 99 { "99+".into() } else { n.to_string() }
}

/// The overlay: a red pill with the count in white, `size` px square (32 reads cleanly at 100-200% scaling).
pub fn overlay(n: u32, size: u32) -> Rgba {
    let mut img = Rgba::new(size, size);
    let s = size as f32;
    let text = label(n);
    let r = s * 0.5 - 0.5;
    let cy = s * 0.5;
    let (x0, x1) = (r + 0.5, s - r - 0.5);
    for y in 0..size {
        for x in 0..size {
            img.blend(x as i32, y as i32, RED, pill(x as f32 + 0.5, y as f32 + 0.5, x0, x1, cy, r));
        }
    }
    let Some(f) = font() else { return img };
    let px = match text.len() { 1 => s * 0.78, 2 => s * 0.62, _ => s * 0.44 };
    let sf = f.as_scaled(PxScale::from(px));
    let ids: Vec<_> = text.chars().map(|c| f.glyph_id(c)).collect();
    let width: f32 = ids.iter().map(|&g| sf.h_advance(g)).sum();
    let mut x = (s - width) / 2.0;
    let baseline = (s + sf.ascent() + sf.descent()) / 2.0;
    for g in ids {
        let glyph = g.with_scale_and_position(PxScale::from(px), point(x, baseline));
        x += sf.h_advance(g);
        if let Some(o) = f.outline_glyph(glyph) {
            let b = o.px_bounds();
            o.draw(|gx, gy, c| img.blend(b.min.x as i32 + gx as i32, b.min.y as i32 + gy as i32, [255, 255, 255], c));
        }
    }
    img
}

/// The tray icon with an unread dot in its top-right corner, cut out from the icon by a 1.5 px ring.
pub fn with_dot(icon: &Rgba) -> Rgba {
    let mut img = Rgba { px: icon.px.clone(), w: icon.w, h: icon.h };
    let s = icon.w.min(icon.h) as f32;
    let r = s * 0.24;
    let (cx, cy) = (s - r - 0.5, r + 0.5);
    for y in 0..icon.h {
        for x in 0..icon.w {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            img.erase(x as i32, y as i32, pill(px, py, cx, cx, cy, r + 1.5));
            img.blend(x as i32, y as i32, RED, pill(px, py, cx, cx, cy, r));
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(label(7), "7");
        assert_eq!(label(42), "42");
        assert_eq!(label(1234), "99+");
    }

    #[test]
    fn overlay_is_drawn() {
        for n in [1, 42, 500] {
            let img = overlay(n, 32);
            assert_eq!(img.px.len(), 32 * 32 * 4);
            // Centre of the pill is opaque; the corners stay transparent.
            assert_eq!(img.px[3], 0);
            let white = img.px.chunks(4).filter(|p| p[3] == 255 && p[0] > 240 && p[1] > 240 && p[2] > 240).count();
            if font().is_some() {
                assert!(white > 10, "{n}: digits drawn ({white} white px)");
            }
        }
    }

    /// `cargo test -- --ignored dump` writes the badges as PNGs for a look (needs SHERIT_BADGE_DIR).
    #[test]
    #[ignore]
    fn dump() {
        let dir = std::env::var("SHERIT_BADGE_DIR").expect("SHERIT_BADGE_DIR");
        for n in [1, 9, 42, 99, 100] {
            let img = overlay(n, 32);
            let mut out = Vec::new();
            {
                let mut e = png::Encoder::new(&mut out, img.w, img.h);
                e.set_color(png::ColorType::Rgba);
                e.set_depth(png::BitDepth::Eight);
                e.write_header().unwrap().write_image_data(&img.px).unwrap();
            }
            std::fs::write(format!("{dir}/badge-{n}.png"), out).unwrap();
        }
    }
}
