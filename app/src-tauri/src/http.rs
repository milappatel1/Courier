//! A tiny HTTP/1.1 server: the OAuth loopback redirect, and (in debug/test builds) the fake mail API.
//! Keep-alive, Content-Length bodies, no chunked requests (reqwest sends lengths).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn q(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    pub fn q_all(&self, key: &str) -> Vec<String> {
        self.query.iter().filter(|(k, _)| k == key).map(|(_, v)| v.clone()).collect()
    }
    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers.get(&key.to_ascii_lowercase()).map(|s| s.as_str())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub fn form(&self) -> HashMap<String, String> {
        parse_query(&String::from_utf8_lossy(&self.body)).into_iter().collect()
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, v: &serde_json::Value) -> Self {
        Response { status, headers: vec![("Content-Type".into(), "application/json; charset=UTF-8".into())], body: serde_json::to_vec(v).unwrap_or_default() }
    }
    pub fn html(status: u16, body: &str) -> Self {
        Response { status, headers: vec![("Content-Type".into(), "text/html; charset=utf-8".into())], body: body.as_bytes().to_vec() }
    }
    pub fn redirect(location: &str) -> Self {
        Response { status: 302, headers: vec![("Location".into(), location.into())], body: vec![] }
    }
    pub fn status(status: u16) -> Self {
        Response { status, headers: vec![], body: vec![] }
    }
}

pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect()
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned()
}

pub async fn read_request<R: tokio::io::AsyncRead + Unpin>(reader: &mut BufReader<R>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().splitn(3, ' ');
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).await? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body).await?;
    }
    let (path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), parse_query(q))).unwrap_or((target.clone(), vec![]));
    Ok(Some(Request { method, path: decode(&path), query, headers, body }))
}

pub async fn write_response<W: tokio::io::AsyncWrite + Unpin>(w: &mut W, r: &Response, keep_alive: bool) -> std::io::Result<()> {
    let reason = match r.status {
        200 => "OK",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "Status",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\n", r.status, reason, r.body.len());
    for (k, v) in &r.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(if keep_alive { "Connection: keep-alive\r\n\r\n" } else { "Connection: close\r\n\r\n" });
    w.write_all(head.as_bytes()).await?;
    w.write_all(&r.body).await?;
    w.flush().await
}

pub type Handler = Arc<dyn Fn(Request) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync>;

/// Serve until the listener errors; each connection gets its own task with keep-alive.
pub async fn serve(listener: TcpListener, handler: Handler) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let h = handler.clone();
        tokio::spawn(async move {
            let _ = serve_conn(stream, h).await;
        });
    }
}

async fn serve_conn(stream: TcpStream, handler: Handler) -> std::io::Result<()> {
    let (r, mut w) = stream.into_split();
    let mut reader = BufReader::new(r);
    while let Some(req) = read_request(&mut reader).await? {
        let close = req.header("connection").map(|v| v.eq_ignore_ascii_case("close")).unwrap_or(false);
        let resp = handler(req).await;
        write_response(&mut w, &resp, !close).await?;
        if close {
            break;
        }
    }
    Ok(())
}

pub fn url_encode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}
