//! Downloads land under a browser-style name ("file (1).pdf" when taken) and never outside their folder.

use courier_lib::commands::{safe_file_name, unique_path};

#[test]
fn downloads_are_named_the_way_a_browser_names_them() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    assert_eq!(unique_path(p, "plan.pdf"), p.join("plan.pdf"));
    std::fs::write(p.join("plan.pdf"), b"x").unwrap();
    assert_eq!(unique_path(p, "plan.pdf"), p.join("plan (1).pdf"));
    std::fs::write(p.join("plan (1).pdf"), b"x").unwrap();
    assert_eq!(unique_path(p, "plan.pdf"), p.join("plan (2).pdf"));
    std::fs::write(p.join("README"), b"x").unwrap();
    assert_eq!(unique_path(p, "README"), p.join("README (1)"));
}

#[test]
fn file_names_from_mail_cant_leave_the_folder() {
    assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
    assert_eq!(safe_file_name("a:b/c\\d.txt"), "a_b_c_d.txt");
    assert_eq!(safe_file_name(".hidden"), "hidden");
    assert_eq!(safe_file_name("   "), "attachment");
}
