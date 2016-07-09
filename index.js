var AWS = require('aws-sdk');
var tcpp = require('tcp-ping');

var dynamodb = new AWS.DynamoDB();

var params ={

};

dynamodb.createTable();
 
tcpp.probe('www.google.com', 80, function(err, data) {
    console.log(data);
});
